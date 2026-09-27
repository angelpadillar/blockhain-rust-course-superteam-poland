#!/usr/bin/env bash
# Sequential Instagram setup batch for the staged identities.
# Each account: photo + display name + first available username candidate.
set -uo pipefail
RUNNER=/opt/buena-multilogin-orchestrator/scripts/run-instagram-account.sh
PHOTOS=/opt/buena-multilogin/private/instagram-photos
while IFS='|' read -r code pid name cands photo; do
  [ -z "$code" ] && continue
  echo "########## $code $(date -u +%FT%TZ)"
  "$RUNNER" "$code" "$pid" "$name" "$cands" "$PHOTOS/$photo"
done <<'SPECS'
K02|a04d004b-14a6-44e2-80b5-d25c99541dcc|Ruby Hayes|rubyfindsai,ruby.finds.ai,rubyfinds.ai|K02.jpg
K03|f7cae3d4-52f8-4a61-b1fc-bf4f62b7fe4d|Lena Cole|lenatalkssales,lena.talks.sales,lenacole.sales|K03.jpg
K04|5a9caf38-b961-45f0-8ba5-910614ae6eba|Maya Bell|mayagrowthtips,maya.growth.tips,mayagrowth.tips|K04.jpg
K05|d97923dd-56db-432f-b640-b3381bc5efaf|Nina Brooks|b2bwithnina,b2b.with.nina,ninabrooks.b2b|K05.jpg
K06|a51b5e8d-6103-410e-8f8f-25b95fbc5617|Chloe Quinn|chloesalestips,chloe.sales.tips,chloesales.tips|K06.jpg
SPECS
