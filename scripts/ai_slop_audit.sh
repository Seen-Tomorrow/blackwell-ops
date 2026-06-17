#!/bin/bash
# AI Slop Detection Audit
# Scans frontend source for patterns common in LLM-generated code

# Patterns to detect:
# 1. Overly verbose comments explaining obvious things
# 2. "Note that" / "Importantly" / "Key point" comments
# 3. Excessive JSDoc for trivial functions  
# 4. "Helper" functions with single callers
# 5. Redundant variable assignments
# 6. "Map" / "reduce" / "filter" chain abuse
# 7. Console.log with debug markers
# 8. TODO/FIXME comments suggesting incomplete reasoning
# 9. "FIXME: verify" / "FIXME: check" patterns
# 10. Dead imports (imported but unused)
# 11. "const" declarations followed by immediate use
# 12. Excessive destructuring for single-use values

echo "=== AI SLOP AUDIT ==="
echo ""

# 1. Comment analysis
echo "--- EXCESSIVE COMMENTS ---"
grep -rn "// Note" src/ 2>/dev/null || echo "No 'Note' comments found"
grep -rn "// Importantly" src/ 2>/dev/null || echo "No 'Importantly' comments found"
grep -rn "// Key" src/ 2>/dev/null || echo "No 'Key' comments found"

# 2. Debug/console markers
echo ""
echo "--- CONSOLE.LOG MARKERS ---"
grep -rn "console.log" src/ 2>/dev/null || echo "No console.log found"

# 3. Dead/unused imports
echo ""
echo "--- POTENTIAL DEAD IMPORTS ---"
grep -rn "import.*unused" src/ 2>/dev/null || echo "No explicit 'unused' markers"

# 4. TODO/FIXME analysis
echo ""
echo "--- TODO/FIXME COMMENTS ---"
grep -rn "TODO" src/ 2>/dev/null || echo "No TODO comments"
grep -rn "FIXME" src/ 2>/dev/null || echo "No FIXME comments"

# 5. Pattern: functions that immediately return their argument
echo ""
echo "--- IDENTITY FUNCTIONS ---"
grep -A2 -B2 "return.*return" src/ 2>/dev/null || echo "No identity functions"

echo ""
echo "=== DONE ==="