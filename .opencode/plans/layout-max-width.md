# Layout Max-Width Constraint — DONE ✅

## Goal
Constrain content to 1280px max-width so the UI renders at the size typical users see (half of a 2560px monitor), while preserving full-width header/footer chrome.

## Status: COMPLETE
Applied `max-w-[1280px] mx-auto` to Layout.tsx:162 content wrapper. Verified on 8K display at 150% app zoom.

## Effect
- On 2560px+ monitors: content centers, dark space left/right (intentional)
- On Full HD (1920px): ~320px padding each side
- On smaller windows (<1280px): fills normally, no scrollbars
