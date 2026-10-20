/**
 * Hexagonal + bounded-context boundaries. Run with `pnpm arch`.
 *
 * Inside a module (src/modules/<ctx>):
 *   domain          -> own domain, shared/kernel. No npm packages, no node builtins.
 *   application     -> own domain/application, shared/kernel.
 *   infrastructure  -> anything in its own module + shared (implements the ports).
 *   interface       -> anything in its own module + shared (drives the use cases).
 * Between modules: only <other>/contracts. shared never imports modules.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'domain-is-pure',
      comment: 'Domain code depends only on its own domain and the shared kernel.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/domain/' },
      to: { pathNot: ['^src/modules/$1/domain/', '^src/shared/kernel/'] },
    },
    {
      name: 'application-depends-inward',
      comment: 'Use cases see the domain and ports, never adapters or frameworks.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/application/' },
      to: { pathNot: ['^src/modules/$1/(domain|application)/', '^src/shared/kernel/'] },
    },
    {
      name: 'no-cross-context-internals',
      comment: 'Bounded contexts talk to each other only through <ctx>/contracts.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/' },
      to: { path: '^src/modules/', pathNot: ['^src/modules/$1/', '^src/modules/[^/]+/contracts/'] },
    },
    {
      name: 'contracts-are-standalone',
      comment: 'Contracts are a published language: plain constants and types.',
      severity: 'error',
      from: { path: '^src/modules/[^/]+/contracts/' },
      to: { pathNot: '^src/modules/[^/]+/contracts/' },
    },
    {
      name: 'shared-knows-no-modules',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: '^src/(modules|main)/' },
    },
    {
      name: 'kernel-is-pure',
      severity: 'error',
      from: { path: '^src/shared/kernel/' },
      to: { pathNot: '^src/shared/kernel/' },
    },
    {
      name: 'composition-root-uses-module-entrypoints',
      comment: 'src/main wires modules through their index.ts only.',
      severity: 'error',
      from: { path: '^src/main/' },
      to: { path: '^src/modules/', pathNot: '^src/modules/[^/]+/index\\.ts$' },
    },
    {
      name: 'workflows-are-deterministic',
      comment:
        'Workflow code runs in the Temporal sandbox: only @temporalio/workflow, contracts and types.',
      severity: 'error',
      from: { path: '^src/modules/([^/]+)/interface/temporal/workflows\\.ts$' },
      to: {
        dependencyTypesNot: ['type-only'],
        pathNot: [
          '@temporalio/workflow',
          '^src/modules/[^/]+/contracts/',
          '^src/modules/$1/interface/temporal/definitions\\.ts$',
        ],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['\\.test\\.ts$', '/testing/'] },
    // typescript@7 has no JS compiler API yet, so parse with swc (keeps type-only import detection)
    parser: 'swc',
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
      extensions: ['.ts', '.js', '.d.ts'],
    },
  },
};
