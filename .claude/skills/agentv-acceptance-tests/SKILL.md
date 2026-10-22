---
name: agentv-acceptance-tests
description: Use when writing or running AgenTV tests, including the image test that installs the ISO in a VM in CI. Builds on Omarchy's acceptance-tests guide and maps tests to the plan's acceptance ids.
paths:
  - "test/agentv/**"
---

# AgenTV tests

Read Omarchy's `agents/skills/acceptance-tests.md` first. Omarchy's own suites (`test/all` and the graphical suite in `test/acceptance.d/`) stay untouched, and they must keep passing.

## Where ours live

Everything AgenTV adds goes under `test/agentv/`, one folder per ADR-019 layer:

| Layer | Folder | Runs |
| --- | --- | --- |
| 1 Check | `test/agentv/policy/` | every commit |
| 2 Unit | `test/agentv/unit/` | every commit |
| 3 Contract | `test/agentv/contract/` | every commit |
| 4 UI | `test/agentv/ui/`, references in `test/agentv/reference/` | every commit, on the Mac too |
| 5 Image | `test/agentv/image/` | CI with KVM: nightly, and on image changes |
| 6 Evals | `test/agentv/evals/` | nightly, and on router or builder changes |
| 7 Hardware | `agentv selftest` on the NUC | before a stage passes, and on tags |

## Rules

- **Name each test after the acceptance id it covers,** for example `S3.10 playback app without tile() gets a continue tile`. A test that covers no id is fine, but say what it guards.
- **Contract tests use saved fixtures,** never a live sign-in. The hand-written Disney+ adapter is the yardstick: an agent-built app must pass the same suite (ADR-011). Disney+ fixtures and tests live in the private `agentv-adapters` repo, never here.
- **UI tests run on a fake daemon** in headless Chromium at 1920 × 1080 (TV) and 390 × 844 (phone). Compare each screen with its reference image from the canvas. An intended visual change updates the reference image in the same commit.
- **Keep Omarchy's hygiene:** restore what you change with traps, close what you open, and save `success-<step>.png` and `failure-<step>.png` for every visually distinct state.

## The image test

Omarchy's guide runs the image test in a VM through the sibling ISO repo. For AgenTV that sibling is `../agentv-iso`, and the VM has to be x86_64 with KVM, which the Mac can't do. So the image test runs in GitHub Actions on `ubuntu-26.04`:
1. Build the ISO from `agentv-os`.
2. Run upstream's `test/integration <iso> boot`: an unattended install, then a boot of the installed system.
3. Run ours from `test/agentv/image/`: no boot password, first boot reaches the TV setup welcome screen (S0.1), then a scripted setup through the companion API to the home screen.

Trigger it with `workflow_dispatch` when you need it on a branch. Read the screenshots it attaches before you call it green.
