---
name: release
description: Create a release, publish to npm, and create a GitHub release. Use when asked to "release", "cut a release", "publish", "bump version", "create release", "npm publish".
---

# Release

Create a versioned release: bump version, update changelog, publish to npm, tag, push, and create a GitHub release.

**Prerequisite:** This skill uses cmux for interactive steps (npm login, publish). Ensure you're running inside cmux.

## Step 1: Determine Version

Check the current version and latest git tag:

```bash
cat package.json | grep '"version"'
git tag -l --sort=-v:refname | head -5
```

If the user provided a version, use it. Otherwise ask:

> What version? (current is X.Y.Z — patch/minor/major, or exact version)

Resolve semver:
- `patch` → X.Y.(Z+1)
- `minor` → X.(Y+1).0
- `major` → (X+1).0.0
- Exact version string → use as-is

## Step 2: Generate Changelog

Get commits since the last tag (or all commits if no tags exist):

```bash
# If tags exist:
git log $(git tag -l --sort=-v:refname | head -1)..HEAD --pretty=format:"- %s" --no-merges

# If no tags:
git log --pretty=format:"- %s" --no-merges
```

Group commits by type using conventional commit prefixes:

| Prefix | Section |
|--------|---------|
| `feat` | ✨ Features |
| `fix` | 🐛 Bug Fixes |
| `refactor` | ♻️ Refactoring |
| `docs` | 📝 Documentation |
| `chore`, `test`, `perf`, `ci` | 🔧 Other Changes |
| No prefix | 🔧 Other Changes |

Format as markdown. Omit empty sections. Strip the `type(scope):` prefix from each line for readability.

**Always start the changelog with this install block** (hardcoded):

````markdown
Install:

```bash
npm install glimpseui@<VERSION>
```

Pi agent package:

```bash
pi install npm:glimpseui@<VERSION>
```
````

Then add the grouped commit sections below it.

## Step 3: Update CHANGELOG.md

Replace the `## Unreleased` section (if present) with `## <VERSION>`, or add a new `## <VERSION>` section at the top. The content should match the generated changelog sections (without the install block — that's for GitHub releases only).

## Step 4: Update package.json

Bump the version in `package.json`:

```bash
# Use a precise edit to change only the version field
```

## Step 5: Commit and Tag

```bash
git add package.json CHANGELOG.md
git commit -m "chore(release): v<VERSION>"
```

Do NOT tag here — the publish script handles tagging.

## Step 6: Ensure npm Login (interactive via cmux)

Spawn a cmux surface to verify npm auth. The user may need to complete OTP/browser auth:

```bash
SURFACE=$(cmux new-surface --type terminal | awk '{print $2}')
sleep 0.5
cmux send --surface $SURFACE 'npm whoami\n'
```

Poll for output. If logged in, you'll see the username. If not:

```bash
cmux send --surface $SURFACE 'npm login\n'
```

Tell the user to complete authentication in the cmux tab, then poll until `npm whoami` succeeds:

```bash
# Poll loop
for i in $(seq 1 60); do
  OUTPUT=$(cmux read-screen --surface $SURFACE --lines 5)
  if echo "$OUTPUT" | grep -qE "^[a-zA-Z0-9]"; then
    # Got a username line — logged in
    break
  fi
  sleep 2
done
```

Close the surface when done:

```bash
cmux close-surface --surface $SURFACE
```

## Step 7: Publish to npm (interactive via cmux)

Run the publish script in a cmux surface so the user can interact with confirmation prompts and OTP challenges:

```bash
SURFACE=$(cmux new-surface --type terminal | awk '{print $2}')
sleep 0.5
cmux send --surface $SURFACE 'cd <PROJECT_ROOT> && ./scripts/publish.sh\n'
```

Tell the user the publish script is running in the cmux tab and they may need to:
- Confirm the publish (`y`)
- Complete OTP/browser authentication if prompted

Poll for completion — look for the success message or error:

```bash
# Poll loop — check every 3 seconds for up to 3 minutes
for i in $(seq 1 60); do
  OUTPUT=$(cmux read-screen --surface $SURFACE --lines 20)
  if echo "$OUTPUT" | grep -q "Published glimpseui@"; then
    echo "Published successfully"
    break
  fi
  if echo "$OUTPUT" | grep -q "Aborted\|npm error\|✗"; then
    echo "Publish failed — check output"
    break
  fi
  sleep 3
done
```

Read the final output for the user:

```bash
cmux read-screen --surface $SURFACE --scrollback --lines 50
```

Close the surface when done:

```bash
cmux close-surface --surface $SURFACE
```

If the publish script already tagged the release, skip to Step 9 (Push).

## Step 8: Tag (if not done by publish script)

```bash
git tag v<VERSION>
```

## Step 9: Push

```bash
git push && git push --tags
```

## Step 10: Create GitHub Release

```bash
gh release create v<VERSION> --title "v<VERSION>" --notes "<CHANGELOG>"
```

Pass the generated changelog (with install block) as the `--notes` value. Use a temp file if the changelog is long:

```bash
echo "<CHANGELOG>" > /tmp/release-notes.md
gh release create v<VERSION> --title "v<VERSION>" --notes-file /tmp/release-notes.md
rm /tmp/release-notes.md
```

## Step 11: Verify

Confirm the release was created:

```bash
gh release view v<VERSION>
```

Print a summary:

```
✅ Released glimpseui@<VERSION>
   npm: https://www.npmjs.com/package/glimpseui
   Tag: v<VERSION>
   URL: https://github.com/HazAT/glimpse/releases/tag/v<VERSION>
```
