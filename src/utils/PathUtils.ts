import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Path and filesystem helper methods used across the framework.
 */
export class PathUtils {
  private constructor() {}

  private static readonly PATH_LOOKUP_SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    'dist',
    'coverage',
    'reports',
    'logs',
  ]);

  private static findNearestProjectRoot(startDir: string): string {
    let current = path.resolve(startDir);

    while (true) {
      const packageJson = path.resolve(current, 'package.json');
      if (fs.existsSync(packageJson)) {
        return current;
      }

      const parent = path.resolve(current, '..');
      if (parent === current) {
        return path.resolve(startDir);
      }
      current = parent;
    }
  }

  static exists(targetPath: string): boolean {
    return fs.existsSync(targetPath);
  }

  static ensureDirectory(dirPath: string): void {
    if (!this.exists(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  static dirname(filePath: string): string {
    return path.dirname(filePath);
  }

  static resolve(...segments: string[]): string {
    return path.resolve(...segments);
  }

  static resolveFromCwd(...segments: string[]): string {
    return path.resolve(process.cwd(), ...segments);
  }

  /**
   * Resolve the consumer project root when this library is used as an npm package.
   * INIT_CWD is provided by npm/yarn/pnpm and points to the original caller directory.
   */
  static getConsumerProjectRoot(): string {
    const initCwd = process.env['INIT_CWD'];
    if (initCwd && initCwd.trim() !== '') {
      return this.findNearestProjectRoot(initCwd);
    }
    return this.findNearestProjectRoot(process.cwd());
  }

  static resolveFromConsumerRoot(...segments: string[]): string {
    return path.resolve(this.getConsumerProjectRoot(), ...segments);
  }

  /**
   * Resolve potential package roots for both source and bundled runtime layouts.
   */
  static getPackageRoots(baseDir: string): string[] {
    const roots = [
      path.resolve(baseDir, '..', '..'),
      path.resolve(baseDir, '..'),
    ];
    return Array.from(new Set(roots));
  }

  static getPackageConfigDirs(baseDir: string): string[] {
    return this.getPackageRoots(baseDir).map((root) => path.resolve(root, 'config'));
  }

  static getPackageDefaultConfigPaths(baseDir: string): string[] {
    return this.getPackageRoots(baseDir).map((root) => path.resolve(root, 'config', 'default.config.yaml'));
  }

  private static schemaCandidates(input: string, roots: string[]): string[] {
    if (path.isAbsolute(input)) return [input];

    const candidates = [input, this.resolveFromCwd(input), this.resolveFromConsumerRoot(input)];
    for (const root of roots) {
      candidates.push(
        path.resolve(root, input),
        path.resolve(root, 'tests', input),
        path.resolve(root, 'test', input),
      );
    }

    if (input.includes('/') || input.includes('\\')) return candidates;
    const fileName = path.basename(input);
    const commonSchemaDirs = [
      'schema',
      'schemas',
      path.join('test', 'schema'),
      path.join('test', 'schemas'),
      path.join('tests', 'schema'),
      path.join('tests', 'schemas'),
      path.join('resources', 'schema'),
      path.join('resources', 'schemas'),
    ];
    for (const root of roots) {
      candidates.push(...commonSchemaDirs.map((dir) => path.resolve(root, dir, fileName)));
    }
    return candidates;
  }

  private static firstExistingFile(candidates: string[]): string | null {
    for (const candidate of candidates) {
      if (this.exists(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  static resolveSchemaPath(schemaPath: string): string | null {
    const input = schemaPath.trim();
    if (!input) {
      return null;
    }

    const hasPathSegment = input.includes('/') || input.includes('\\');
    const fileName = path.basename(input);

    const roots = Array.from(
      new Set([
        process.cwd(),
        this.findNearestProjectRoot(process.cwd()),
        this.getConsumerProjectRoot(),
      ]),
    );

    const existingFile = this.firstExistingFile(this.schemaCandidates(input, roots));
    if (existingFile) return existingFile;

    if (!hasPathSegment) {
      for (const root of roots) {
        const found = this.findFileByName(root, fileName, 8);
        if (found) {
          return found;
        }
      }
    }

    return null;
  }

  private static findFileByName(startDir: string, fileName: string, depth: number): string | null {
    if (depth < 0 || !this.exists(startDir)) {
      return null;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(startDir, { withFileTypes: true });
    } catch {
      return null;
    }

    // Prefer direct file hit before descending into subdirectories.
    for (const entry of entries) {
      if (entry.isFile() && entry.name === fileName) {
        return path.resolve(startDir, entry.name);
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (this.PATH_LOOKUP_SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const found = this.findFileByName(path.resolve(startDir, entry.name), fileName, depth - 1);
      if (found) {
        return found;
      }
    }

    return null;
  }
}
