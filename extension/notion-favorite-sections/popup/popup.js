"use strict";

const versionElement = document.querySelector("[data-version]");
const manifest = globalThis.chrome?.runtime?.getManifest?.();

if (versionElement && manifest) {
  versionElement.textContent = manifest.version;
}
