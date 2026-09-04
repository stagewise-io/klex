const requiredMajor = 26;
const currentVersion = process.versions.node;
const currentMajor = Number.parseInt(currentVersion.split('.')[0] ?? '', 10);

if (currentMajor !== requiredMajor) {
  console.error(
    `Node.js 26 is required; current version is ${currentVersion}. Use the version pinned in .nvmrc.`,
  );
  process.exit(1);
}
