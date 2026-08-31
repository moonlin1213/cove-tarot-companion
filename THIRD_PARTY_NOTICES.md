# Third-party notices

Connector code and documentation are licensed under the root ISC license. No private deck, personal artwork, host application code or provider account is bundled.

The installer downloads [Tarot Ritual](https://github.com/moonlin1213/tarot-ritual) at the exact commit in `engine-lock.json` into `engine/`. Its ISC copyright notice is **Copyright (c) 2026 Tarot Ritual contributors**; its full `LICENSE` and `THIRD_PARTY_NOTICES.md` remain in the installed engine. Upstream notices must be preserved when redistributing it.

| Installed engine component | License | Notice retained inside engine |
| --- | --- | --- |
| Tarot Ritual project code | ISC | `LICENSE` |
| Three.js 0.185.1 | MIT | `public/vendor/LICENSE-three.txt` and npm package |
| Cinzel font | SIL OFL 1.1 | `public/fonts/OFL-Cinzel.txt` |
| Cormorant Garamond font | SIL OFL 1.1 | `public/fonts/OFL-Cormorant-Garamond.txt` |
| js-yaml 5.4.1 | MIT | npm package license |
| argparse 2.0.1 | Python-2.0 | npm package license |

Traditional tarot names and symbolism are distinct from commercial deck artwork. The public engine renders programmatic illustrations; users adding custom images are responsible for their rights and notices. Necessary public source account identifiers and upstream copyright attributions are not removed as private data.

Playwright 1.62.1 is an optional development/test dependency under Apache-2.0, installed separately by CI or the contributor. Its license and browser notices accompany that distribution; browser binaries are not bundled in this repository or the connector's runtime package. There are no additional connector runtime npm dependencies.
