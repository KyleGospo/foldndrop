/* Fold n' Drop — GPL-3.0. Minimal test harness; no gi imports. */
'use strict';

const suites = [];
let current = null;

export function describe(name, fn) {
    current = { name, tests: [] };
    suites.push(current);
    fn();
    current = null;
}

export function it(name, fn) {
    if (!current)
        throw new Error('it() called outside describe()');
    current.tests.push({ name, fn });
}

export function assert(cond, msg = 'assertion failed') {
    if (!cond)
        throw new Error(msg);
}

export function assertEqual(actual, expected, msg = 'not equal') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${msg}\n    expected: ${e}\n    actual:   ${a}`);
}

export function assertClose(actual, expected, eps = 1e-9, msg = 'not close') {
    if (!(Math.abs(actual - expected) <= eps))
        throw new Error(`${msg}\n    expected: ${expected} +/- ${eps}\n    actual:   ${actual}`);
}

export function assertVecClose(actual, expected, eps = 1e-9, msg = 'vectors not close') {
    assertClose(actual.x, expected.x, eps, `${msg} (x)`);
    assertClose(actual.y, expected.y, eps, `${msg} (y)`);
}

export function runAll() {
    let passed = 0;
    let failed = 0;
    for (const suite of suites) {
        console.log(`\n${suite.name}`);
        for (const test of suite.tests) {
            try {
                test.fn();
                passed++;
                console.log(`  ok   ${test.name}`);
            } catch (e) {
                failed++;
                console.log(`  FAIL ${test.name}`);
                console.log(`       ${e.message.split('\n').join('\n       ')}`);
            }
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    return failed === 0 ? 0 : 1;
}
