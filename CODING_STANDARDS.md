# Strict Coding Standards Guide

This document outlines the strict coding guidelines enforced by our ESLint and Prettier configuration. All team members must adhere to these standards.

## Table of Contents
1. [Type Safety](#type-safety)
2. [Code Quality](#code-quality)
3. [Naming Conventions](#naming-conventions)
4. [React Guidelines](#react-guidelines)
5. [Error Handling](#error-handling)
6. [Import Organization](#import-organization)
7. [Formatting Rules](#formatting-rules)
8. [Enforcement](#enforcement)

---

## Type Safety

### No `any` Types ❌ FORBIDDEN

**Rule**: `@typescript-eslint/no-explicit-any` (error)

```typescript
// ❌ WRONG
function process(data: any): void {
  console.log(data);
}

// ✅ CORRECT
function process(data: unknown): void {
  if (typeof data === 'string') {
    console.log(data);
  }
}
```

### Explicit Function Return Types

**Rule**: `@typescript-eslint/explicit-function-return-types` (error)

All functions must have explicit return types:

```typescript
// ❌ WRONG
function getValue() {
  return 42;
}

// ✅ CORRECT
function getValue(): number {
  return 42;
}

// ✅ Arrow functions
const getValue = (): number => 42;
```

### Explicit Member Accessibility

**Rule**: `@typescript-eslint/explicit-member-accessibility` (error)

All class members must have explicit access modifiers:

```typescript
// ❌ WRONG
class User {
  name: string;
  
  constructor(name: string) {
    this.name = name;
  }
}

// ✅ CORRECT
class User {
  public name: string;
  
  public constructor(name: string) {
    this.name = name;
  }
}
```

### Strict Boolean Expressions

**Rule**: `@typescript-eslint/strict-boolean-expressions` (error)

Boolean expressions must be explicit:

```typescript
// ❌ WRONG
if (user) { }  // ambiguous
if (count) { } // ambiguous

// ✅ CORRECT
if (user !== null && user !== undefined) { }
if (count > 0) { }
if (count !== 0) { }
```

### No Non-null Assertions

**Rule**: `@typescript-eslint/no-non-null-assertion` (warn)

Minimize use of `!` operator. Prefer type narrowing:

```typescript
// ❌ AVOID (unless absolutely necessary)
const name = user!.name;

// ✅ PREFER
if (user) {
  const name = user.name;
}
```

### Async/Promise Handling

**Rules**: 
- `@typescript-eslint/no-floating-promises` (error)
- `@typescript-eslint/await-thenable` (error)
- `@typescript-eslint/no-misused-promises` (error)

```typescript
// ❌ WRONG
async function fetchData(): Promise<void> {
  fetchUser(); // Promise not awaited
  if (isReady()) { }  // isReady is async, must await
}

// ✅ CORRECT
async function fetchData(): Promise<void> {
  await fetchUser();
  if (await isReady()) { }
}
```

### Nullish Coalescing & Optional Chaining

**Rules**:
- `@typescript-eslint/prefer-nullish-coalescing` (error)
- `@typescript-eslint/prefer-optional-chain` (error)

```typescript
// ❌ WRONG
const value = user && user.profile && user.profile.name;
const name = user ? user.name : 'Unknown';

// ✅ CORRECT
const value = user?.profile?.name;
const name = user?.name ?? 'Unknown';
```

---

## Code Quality

### No Console Logs in Production

**Rule**: `no-console` (warn, only `warn` and `error` allowed)

```typescript
// ❌ WRONG
console.log('Debug info');
console.info('Information');

// ✅ CORRECT
console.warn('Warning message');
console.error('Error occurred');

// For debugging, use:
if (process.env['DEBUG']) {
  console.debug('Development info');
}
```

### No Debugger Statements

**Rule**: `no-debugger` (error)

```typescript
// ❌ WRONG
debugger;

// Use IDE debugger instead
```

### Const by Default

**Rules**:
- `no-var` (error)
- `prefer-const` (error)

```typescript
// ❌ WRONG
var x = 5;
let y = 5;
y = 6; // if y never reassigned, should be const

// ✅ CORRECT
const x = 5;
let counter = 0;
counter++;
```

### Arrow Functions Over Function Expressions

**Rule**: `prefer-arrow-callback` (error)

```typescript
// ❌ WRONG
array.map(function(item) {
  return item * 2;
});

// ✅ CORRECT
array.map((item): number => item * 2);
```

### No Magic Numbers

**Rule**: `no-magic-numbers` (warn)

```typescript
// ❌ WRONG
const daysToExpire = 30;
if (age < 18) { }

// ✅ CORRECT
const THIRTY_DAYS = 30;
const ADULT_AGE = 18;

const daysToExpire = THIRTY_DAYS;
if (age < ADULT_AGE) { }
```

### Strict Equality

**Rule**: `eqeqeq` (error, always use === or !==)

```typescript
// ❌ WRONG
if (value == 0) { }
if (status != 'active') { }

// ✅ CORRECT
if (value === 0) { }
if (status !== 'active') { }
```

### No Empty Functions

**Rule**: `no-empty-function` (error)

```typescript
// ❌ WRONG
function doNothing(): void { }

// ✅ CORRECT
function doNothing(): void {
  // Intentionally empty
}

// Or better, don't create empty functions
```

---

## Naming Conventions

**Rule**: `@typescript-eslint/naming-convention` (error)

### Variables & Functions: camelCase

```typescript
// ❌ WRONG
const user_name = 'John';
function Get_User(): User { }

// ✅ CORRECT
const userName = 'John';
function getUser(): User { }
```

### Classes, Interfaces, Types: PascalCase

```typescript
// ❌ WRONG
class user_account { }
interface user_data { }
type userProfile = { }

// ✅ CORRECT
class UserAccount { }
interface UserData { }
type UserProfile = { }
```

### Constants: UPPER_SNAKE_CASE

```typescript
// ❌ WRONG
const maxRetries = 3;
const API_URL = 'https://api.example.com';

// ✅ CORRECT
const MAX_RETRIES = 3;
const API_URL = 'https://api.example.com';
```

### Unused Variables: Prefix with `_`

```typescript
// ❌ WRONG
function unused(_param: string): void {
  const result = 5;
  console.log('Hello');
}

// ✅ CORRECT
function unused(_param: string): void {
  const _result = 5;
  console.log('Hello');
}
```

---

## React Guidelines

### Keys in Lists

**Rule**: `react/no-array-index-key` (error)

```typescript
// ❌ WRONG
items.map((item, index) => <div key={index}>{item}</div>);

// ✅ CORRECT
items.map((item) => <div key={item.id}>{item.name}</div>);
```

### Self-Closing Components

**Rule**: `react/self-closing-comp` (error)

```typescript
// ❌ WRONG
<Component></Component>
<img src="..." />

// ✅ CORRECT
<Component />
<img src="..." alt="description" />
```

### Hooks Rules

**Rule**: `react-hooks/rules-of-hooks` (error)

```typescript
// ❌ WRONG
if (condition) {
  const [state, setState] = useState(0); // Hook called conditionally
}

// ✅ CORRECT
const [state, setState] = useState(0);
if (condition) {
  // use state
}
```

### Exhaustive Deps

**Rule**: `react-hooks/exhaustive-deps` (warn)

```typescript
// ❌ WRONG
useEffect(() => {
  console.log(userId);
}, []); // Missing userId in dependencies

// ✅ CORRECT
useEffect(() => {
  console.log(userId);
}, [userId]);
```

### Accessibility: Alt Text

**Rule**: `jsx-a11y/alt-text` (error)

```typescript
// ❌ WRONG
<img src="photo.jpg" />

// ✅ CORRECT
<img src="photo.jpg" alt="User avatar" />
```

---

## Error Handling

### Throw Only Error Objects

**Rule**: `@typescript-eslint/no-throw-literal` (error)

```typescript
// ❌ WRONG
throw 'An error occurred';
throw 404;

// ✅ CORRECT
throw new Error('An error occurred');
throw new HttpException('Not found', 404);
```

---

## Import Organization

**Rule**: `import/order` (warn)

```typescript
// ✅ CORRECT ORDER
// 1. Built-in modules
import fs from 'fs';
import path from 'path';

// 2. External packages
import express from 'express';
import lodash from 'lodash';

// 3. Internal modules
import { config } from '@org/config';
import { logger } from '@org/logger';

// 4. Parent directory imports
import { parentModule } from '../modules';

// 5. Sibling imports
import { sibling } from './sibling';

// 6. Index imports
import type { Model } from './index';
```

### No Circular Dependencies

**Rule**: `import/no-cycle` (error)

Circular dependencies cause maintenance issues and potential runtime errors.

---

## Formatting Rules

All formatting is handled by **Prettier**. Run `npm run format` before committing.

### Configuration
- **Quote Style**: Single quotes (`'`)
- **Semicolons**: Required
- **Tab Width**: 2 spaces
- **Line Length**: 100 characters
- **Trailing Commas**: ES5 (objects, arrays only)
- **Spaces**: Around brackets `{ key }`
- **Arrow Functions**: Always parenthesize parameters `(a) => a * 2`
- **Line Endings**: Unix (LF)

```typescript
// ✅ CORRECT
const user = { name: 'John', age: 30 };
const values = [1, 2, 3];
const double = (x): number => x * 2;
```

---

## Enforcement

### Running Linters

```bash
# Lint all projects
npm exec nx lint --all

# Lint specific project
npm exec nx lint frontend

# Fix auto-fixable issues
npm exec nx lint --all --fix

# Format code
npm run format
```

### Pre-commit Hooks

Consider adding git hooks to run linting before commits:

```bash
npm install -D husky lint-staged
npx husky install
```

### CI/CD Integration

All pull requests must pass linting checks:

```bash
npm exec nx lint --all
npm exec nx format:check
```

---

## Violations & Exceptions

### When to Request Exceptions

Exceptions to these rules should be rare. If you need an exception:

1. Document the reason in a code comment
2. Use ESLint disable comments sparingly:

```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data: any = externalLibrary.getData();
```

3. Discuss with the team why the rule doesn't apply

### Common Exceptions

- **Magic Numbers**: Configuration values (ports, timeouts) can be exceptions
- **Console Logs**: Development-only logging with environment checks
- **Non-null Assertions**: Third-party library return values that are guaranteed non-null

---

## Resources

- [ESLint Documentation](https://eslint.org/docs/latest/)
- [TypeScript-ESLint Rules](https://typescript-eslint.io/rules/)
- [Prettier Documentation](https://prettier.io/docs/)
- [React Hooks Rules](https://react.dev/reference/rules/rules-of-hooks)
- [Web Accessibility (A11y)](https://www.w3.org/WAI/WCAG21/quickref/)

---

**Last Updated**: 2026-05-14
**Enforced By**: ESLint + Prettier
**Violations**: Errors block PRs, Warnings should be addressed
