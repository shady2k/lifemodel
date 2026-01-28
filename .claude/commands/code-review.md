Review code changes using the code-reviewer subagent.

## Target Selection
If argument provided: review that specific file, directory, or commit hash ($ARGUMENTS)
If no argument: review all current changes (`git diff HEAD`) - includes both staged and unstaged

## Review Criteria

## Security
- Input validation and sanitization
- Authentication/authorization issues
- Injection vulnerabilities (SQL, command, XSS)
- Sensitive data exposure
- Insecure dependencies

## Code Quality
- TypeScript strict mode compliance (no `any`, proper null handling)
- Error handling completeness
- Code duplication and DRY violations
- Single responsibility principle adherence
- Naming clarity and consistency
- ESLint disable comments (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`) - flag and suggest proper fixes

## Performance
- N+1 query patterns
- Unnecessary re-renders (React components)
- Missing memoization opportunities
- Inefficient algorithms or data structures

## Project Standards
- Pino logger signature (context object first, then message)
- NestJS decorator patterns
- Prisma best practices

Provide specific line references and actionable fixes for each issue found.