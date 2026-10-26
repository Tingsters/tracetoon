import { pathToFileURL } from 'node:url';
import { evaluateComics } from './comic-evaluation.ts';

console.log(
  pathToFileURL(
    await evaluateComics(
      process.cwd(),
      process.argv[2] ?? 'prepare',
      process.argv.slice(3),
    ),
  ).href,
);
