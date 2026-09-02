/* Fold n' Drop — GPL-3.0. Test suite for harness; no gi imports. */
import { describe, it, assert, assertEqual, assertClose, assertVecClose } from './harness.js';

describe('harness', () => {
    it('assert passes on true', () => {
        assert(true, 'should not throw');
    });
    it('assertEqual compares by structure', () => {
        assertEqual({ x: 1, y: 2 }, { x: 1, y: 2 });
    });
    it('assertClose tolerates float error', () => {
        assertClose(0.1 + 0.2, 0.3, 1e-9);
    });
    it('assertVecClose compares both components', () => {
        assertVecClose({ x: 1.0000000001, y: 2 }, { x: 1, y: 2 }, 1e-6);
    });
    it('a failing assertion throws', () => {
        let threw = false;
        try {
            assert(false, 'boom');
        } catch (e) {
            threw = true;
        }
        assert(threw, 'assert(false) must throw');
    });
});
