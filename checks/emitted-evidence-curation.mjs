import assert from "node:assert/strict";

const { EvidenceCurationService } = await import(
  "../dist/research/curation/evidence-curation.engine.js"
);
const { EvidenceCurationModule } = await import(
  "../dist/research/curation/evidence-curation.module.js"
);

const module = EvidenceCurationModule.register({ semanticAttemptLimit: 3 });
assert.equal(module.module, EvidenceCurationModule);
assert.equal(module.exports.includes(EvidenceCurationService), true);

const service = new EvidenceCurationService(
  async () => [{ address: "93.184.216.34", family: 4 }],
  { async fetchPinned() { return new Response(); } },
  { async sleep() {} },
);
assert.equal(
  service.storyFingerprint({ title: "A typed evidence story", summary: "Proof" }).length,
  64,
);
