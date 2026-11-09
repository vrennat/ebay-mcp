#!/usr/bin/env node
/**
 * Offline MCPB builder. Run after tests: node readonly/build-mcpb.mjs [OUTPUT.mcpb]
 * Uses the installed production dependencies plus the system `zip` command.
 * Does not install packages, execute package scripts, change settings, or publish.
 * Open the resulting bundle in Claude Desktop and enter tokens in its sensitive fields.
 * Format: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
 * Installation: https://www.anthropic.com/research/desktop-extensions
 */
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu;
const LIMIT_BYTES = 64 * 1024 * 1024;
const LIMIT_FILES = 15_000;

const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

async function dependencyGraph(root) {
  const dependencyRoot = await fs.realpath(path.join(root, 'node_modules'));
  const graph = new Map();
  const primary = new Map();
  async function locate(name, from) {
    if (!PACKAGE_NAME.test(name) || name.includes('..')) {
      throw new Error('Unsafe dependency name.');
    }
    for (let current = from; inside(root, current); current = path.dirname(current)) {
      try {
        const resolved = await fs.realpath(path.join(current, 'node_modules', name));
        if (!inside(dependencyRoot, resolved)) {
          throw new Error('A dependency resolves outside this checkout node_modules.');
        }
        return resolved;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      if (current === root) {
        break;
      }
    }
    const error = new Error(
      `Installed dependency missing: ${name}. Install the project's locked dependencies first.`,
    );
    error.code = 'DEPENDENCY_MISSING';
    throw error;
  }
  async function visit(name, from, optional = false) {
    let source;
    try {
      source = await locate(name, from);
    } catch (error) {
      if (optional && error.code === 'DEPENDENCY_MISSING') {
        return null;
      }
      throw error;
    }
    if (graph.has(source)) {
      return graph.get(source);
    }
    const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    if (metadata.name !== name || typeof metadata.version !== 'string') {
      throw new Error('Unexpected installed package metadata.');
    }
    const node = { source, metadata, dependencies: new Map() };
    graph.set(source, node);
    if (!primary.has(name)) {
      primary.set(name, node);
    }
    const dependencies = {
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
      ...metadata.peerDependencies,
    };
    for (const childName of Object.keys(dependencies)) {
      const child = await visit(
        childName,
        source,
        Boolean(
          metadata.optionalDependencies?.[childName] ||
            metadata.peerDependenciesMeta?.[childName]?.optional,
        ),
      );
      if (child) {
        node.dependencies.set(childName, child);
      }
    }
    return node;
  }
  // Preserve root resolution for the only two direct external imports.
  await visit('zod', root);
  await visit('@modelcontextprotocol/sdk', root);
  return { graph, primary };
}

function zipDirectory(directory, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn('zip', ['-q', '-r', destination, '.'], {
      cwd: directory,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.resume();
    child.on('error', () =>
      reject(
        new Error(
          'The offline builder requires the system zip command. No packages were installed.',
        ),
      ),
    );
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error('The zip command failed. No bundle was published.')),
    );
  });
}

export async function buildBundle({ outputPath, root = ROOT } = {}) {
  root = await fs.realpath(root);
  const source = path.join(root, 'readonly');
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  if (
    manifest.manifest_version !== '0.3' ||
    manifest.name !== 'ac-ebay-readonly' ||
    manifest.server?.entry_point !== 'index.mjs'
  ) {
    throw new Error('Unexpected bundle manifest. Revalidate it against the official MCPB schema.');
  }
  const output = path.resolve(
    outputPath ?? path.join(source, 'dist', `${manifest.name}-${manifest.version}.mcpb`),
  );
  if (path.extname(output) !== '.mcpb') {
    throw new Error('Output must have the .mcpb extension.');
  }
  try {
    await fs.lstat(output);
    throw new Error(
      'Output already exists. Choose a new filename; existing files are never overwritten.',
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const { graph, primary } = await dependencyGraph(root);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-ebay-mcpb-'));
  const stage = path.join(temporary, 'bundle');
  let bytes = 0;
  let files = 0;
  async function copyFile(from, to) {
    const stat = await fs.lstat(from);
    if (!stat.isFile()) {
      throw new Error('Bundle inputs must be regular files, not symlinks or devices.');
    }
    bytes += stat.size;
    files += 1;
    if (bytes > LIMIT_BYTES || files > LIMIT_FILES) {
      throw new Error('Bundle exceeds the safety size limit (64 MiB / 15,000 files).');
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to, constants.COPYFILE_EXCL);
    await fs.chmod(to, stat.mode & 0o111 ? 0o755 : 0o644);
  }
  async function copyTree(from, to) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (
        ['node_modules', '.git', '.npmrc', '.DS_Store'].includes(entry.name) ||
        entry.name.startsWith('.env')
      ) {
        continue;
      }
      const input = path.join(from, entry.name);
      const output = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await copyTree(input, output);
      } else {
        await copyFile(input, output);
      }
    }
  }
  async function installNestedDependencies(node, destination, visible) {
    const local = new Map(visible);
    const nested = [];
    for (const [name, dependency] of node.dependencies) {
      if (local.get(name)?.source === dependency.source) {
        continue;
      }
      local.set(name, dependency);
      const target = path.join(destination, 'node_modules', name);
      await copyTree(dependency.source, target);
      nested.push([dependency, target]);
    }
    for (const [dependency, target] of nested) {
      await installNestedDependencies(dependency, target, local);
    }
  }
  try {
    await fs.mkdir(stage);
    // Explicit allowlist: no upstream write-capable server, repository config, caches, or credentials.
    for (const name of [
      'manifest.json',
      'index.mjs',
      'core.mjs',
      'catalog.json',
      'setup.mjs',
      'DESKTOP_EXTENSION.md',
    ]) {
      await copyFile(path.join(source, name), path.join(stage, name));
    }
    for (const name of ['LICENSE', 'README.md', 'SECURITY.md']) {
      await copyFile(path.join(root, name), path.join(stage, name));
    }
    for (const [name, node] of primary) {
      await copyTree(node.source, path.join(stage, 'node_modules', name));
    }
    for (const [name, node] of primary) {
      await installNestedDependencies(node, path.join(stage, 'node_modules', name), primary);
    }
    await fs.writeFile(
      path.join(stage, 'package.json'),
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          private: true,
          type: 'module',
          engines: { node: manifest.compatibility.runtimes.node },
          dependencies: Object.fromEntries(
            ['@modelcontextprotocol/sdk', 'zod'].map((name) => [
              name,
              primary.get(name).metadata.version,
            ]),
          ),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
    await fs.writeFile(
      path.join(stage, 'BUNDLE-NOTES.txt'),
      [
        'AC eBay Read-Only: local, unsigned MCPB bundle.',
        'Open this .mcpb in Claude Desktop, review the extension, and enter tokens only in its sensitive settings fields.',
        'Requires your existing eBay developer account/application and OAuth access token. This bundle does not issue credentials.',
        'Tokens expire. Replace them in extension settings. No network request is made by the offline builder.',
        'Read-only responses can include private account or buyer data. Request only what you intend to share with your AI client.',
        'Built from a specific local source snapshot and installed dependencies. No automatic update or external publication is configured.',
        'Manifest format: MCPB v0.3. Revalidate manifest edits against the official schema before distributing.',
        'Schema: https://github.com/modelcontextprotocol/mcpb/blob/main/schemas/mcpb-manifest-v0.3.schema.json',
        'Format: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md',
        'Install: https://www.anthropic.com/research/desktop-extensions',
        `Bundled dependency packages: ${graph.size}.`,
        ...[...graph.values()]
          .map((node) => `${node.metadata.name}@${node.metadata.version}`)
          .sort(),
        '',
      ].join('\n'),
      { flag: 'wx' },
    );
    const archive = path.join(temporary, 'archive.mcpb');
    await zipDirectory(stage, archive);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(archive, output, constants.COPYFILE_EXCL);
    return {
      output,
      archiveBytes: (await fs.stat(output)).size,
      inputBytes: bytes,
      files,
      packages: graph.size,
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Usage: node readonly/build-mcpb.mjs [OUTPUT.mcpb]\nOffline build using installed dependencies and system zip. Existing outputs are never overwritten.\n',
    );
  } else if (process.argv.length > 3) {
    process.stderr.write('Provide at most one output filename.\n');
    process.exitCode = 1;
  } else {
    buildBundle({ outputPath: process.argv[2] })
      .then((result) => {
        process.stdout.write(
          `Created ${result.output}\n${result.packages} dependency packages; ${(result.archiveBytes / 1024 / 1024).toFixed(2)} MiB compressed.\nUnsigned local build, not installed or published.\n`,
        );
      })
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
