# Contributing to Heeler

Pull requests are welcome, on one condition: **show that the tests pass.**

Heeler comes with a large test suite, and one command runs all of it:

```
python3 scripts/test.py
```

It runs the release script's tests, the Rust workspace, the frontend's type check and the frontend suite, and it ends with `All suites passed.` when everything is green. Running it takes no special setup beyond what [building](README.md#building) already needs.

## What a pull request must include

1. **The test run on all three platforms Heeler builds on: macOS, Windows and Linux.** Paste the end of `python3 scripts/test.py` from each, with the `All suites passed.` line, and say which machine and OS version each ran on. Every release is tested on all three, and so is every pull request.
2. **Tests for the change.** A fix comes with a test that fails without it; a feature comes with tests of what it does. A pull request that changes behavior and adds no test is not done.
3. **A description of what changed and why**, in plain words.

A pull request without the test runs is closed without being read. Not running them is not a reason anyone has to accept: the suite is one command.

## What a pull request is not

- **A promise it will be merged.** Heeler has one maintainer who decides what goes in, including turning down working, tested code that does not fit.
- **A claim on anything.** What you submit is licensed under the [Mozilla Public License 2.0](LICENSE), the same as the rest of Heeler, and you confirm you have the right to submit it. No payment, credit or ownership is owed for a contribution or a suggestion.

## Bugs and suggestions

Write to support@heeler.app. Suggestions are given freely, without a promise of payment or adoption.
