import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.mjs';

export default [
  ...baseConfig,
  ...nx.configs['flat/react'],
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      // React Hooks Rules
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // React Best Practices
      'react/no-array-index-key': 'error',
      'react/prop-types': 'warn',
      'react/jsx-key': 'error',
      'react/self-closing-comp': 'error',
      'react/no-unescaped-entities': 'warn',
      'react/display-name': 'warn',

      // JSX Accessibility
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/img-redundant-alt': 'error',

      // Import/Export
      'import/order': [
        'warn',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
        },
      ],
      'import/no-cycle': 'error',
      'import/no-default-export': 'warn',
    },
  },
];
