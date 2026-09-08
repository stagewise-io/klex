const requiredMajor = 26;
const currentVersion = process.versions.node;
const currentMajor = Number.parseInt(currentVersion.split('.')[0] ?? '', 10);

if (process.env.VERCEL) {
  // Deployment context (Vercel) — website builds with Node 24+ are supported.
  if (currentMajor < 24) {
    console.error(
      `Node.js >=24 is required on Vercel; current version is ${currentVersion}.`,
    );
    process.exit(1);
  }
  console.warn(
    `Vercel build detected — skipping Node.js 26 requirement (current: ${currentVersion}).`,
  );
  process.exit(0);
}

if (currentMajor !== requiredMajor) {
  console.error(
    `Node.js 26 is required; current version is ${currentVersion}. Use the version pinned in .nvmrc.`,
  );
  process.exit(1);
}
