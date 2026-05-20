import nx from '@nx/eslint-plugin';
import tseslint from 'typescript-eslint';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: false,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.mts', '.cts'],
      },
    },
  },
  {
    ignores: [
      '**/dist',
      '**/out-tsc',
      '**/*.d.ts',
      '**/vite.config.*',
      '**/vitest.config.*',
      '**/jest.config.*',
      '**/*.config.*',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
      '**/public'
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: [
          './apps/frontend/tsconfig.app.json',
          './apps/frontend/tsconfig.spec.json',
          './apps/infra/tsconfig.json',
        ],
      },
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: '*',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/infra/**/*.{ts,tsx,js,jsx}'],
    rules: {
      '@nx/enforce-module-boundaries': 'off',
    },
  },
  // STRICT CODING GUIDELINES
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Type Safety - Enforce strict type system
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
          accessibility: 'explicit',
          overrides: {
            constructors: 'no-public',
          },
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
          trailingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        }
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',

      // Code Quality
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-alert': 'warn',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'no-magic-numbers': [
        'warn',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
        },
      ],
      'no-empty-function': 'error',
      'no-implicit-coercion': 'error',
      'no-eval': 'error',
      eqeqeq: ['error', 'always'],

      // Import Organization
      'sort-imports': [
        'warn',
        {
          ignoreCase: true,
          ignoreDeclarationSort: true,
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.jsx'],
    rules: {
      // JavaScript-specific code quality
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-empty-function': 'error',
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    rules: {
      // General best practices
      'no-duplicate-imports': 'error',
      'no-self-compare': 'error',
      'no-constant-condition': 'error',
      'no-unreachable': 'error',
    },
  },
];
