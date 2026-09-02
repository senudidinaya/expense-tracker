import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest's globals are off in this workspace (every test imports `describe`
// and friends explicitly), and Testing Library only auto-cleans when it can
// see a global `afterEach`. Without this, mounted trees from one test are
// still in the document during the next, and `getByLabelText` starts finding
// two of everything.
afterEach(cleanup);
