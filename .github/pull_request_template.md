## Description

Briefly describe what this PR does and why.

## Related Issues

Closes Issue # (include link)

## Changes

Summarize the key changes made in this PR.

## Checklist

Before submitting, please confirm the following:

### Testing

- [ ] New or updated unit tests cover the changes
- [ ] Integration tests cover the changes where applicable
- [ ] All existing tests pass (`npm test`)

### Type Safety

- [ ] All new code is properly typed (no `any` unless justified and documented)
- [ ] Public API types are updated if the interface has changed

### Documentation

- [ ] Code is documented with JSDoc comments where appropriate
- [ ] README or other published documentation is updated if user-facing behavior has changed
- [ ] Error handling contract is documented for any new failure modes

### Observability

- [ ] Relevant metrics are emitted for new operations
- [ ] Log messages are added at appropriate levels (debug for routine operations, warn/error for failures)
- [ ] Errors follow the established contract (cache reads respect fallback, writes/invalidation are best-effort)

### General

- [ ] Linting passes (`npm run lint`)
- [ ] No unnecessary dependencies added
- [ ] Changes are backward compatible (or breaking changes are clearly documented)
