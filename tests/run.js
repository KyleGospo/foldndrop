/* Fold n' Drop — GPL-3.0. GJS test runner; no gi imports. */
import System from 'system';
import { runAll } from './harness.js';

import './harness.test.js';
import './geometry.test.js';
import './animation.test.js';
import './crossing.test.js';
import './fold.test.js';
import './gesture.test.js';
import './coherency.test.js';
import './session.test.js';

System.exit(runAll());
