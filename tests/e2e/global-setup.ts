import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeAllFixtures } from '../fixtures/fixtures';

export default async function globalSetup() {
  if (!existsSync(join(import.meta.dirname, '..', '..', 'dist', 'index.html'))) {
    throw new Error('dist/ is missing. Run `npm run build` first (npm run test:e2e does this for you).');
  }
  await writeAllFixtures();
}
