# AccessLease operator runbook

Everything an operator needs to run AccessLease, in the order you need it.

| Document | Use it to |
| --- | --- |
| [install.md](install.md) | Install with Docker Compose or natively, create the first administrator, understand bind addresses. |
| [smoke.md](smoke.md) | Prove an installation works with synthetic data. Copy-paste commands for a fresh operator. |
| [upgrade.md](upgrade.md) | Upgrade safely: stop side-effect workers, back up, test the restore, migrate. |
| [backup-restore.md](backup-restore.md) | Back up, restore, and reconcile external outcomes before enabling writes. |
| [diagnosis.md](diagnosis.md) | Diagnose failures, including every lease state, the residual-access window and exit codes. |
| [../ADAPTERS.md](../ADAPTERS.md) | Optional ecosystem event consumer (disabled by default). |

## Three rules that run through all of it

1. **Expired is not revoked.** A lease is revoked only when revocation was independently verified. Elapsed time never counts.
2. **Unknown stays visible.** `ISSUE_UNKNOWN` and `REVOCATION_UNCONFIRMED` mean access may still exist. They show as warnings, the CLI exits with code 4 when any is present, and nothing turns them green except a verified result.
3. **A restored database cannot undo remote effects.** If you restore a backup, reconcile what really exists at the provider before you let the worker write again ([backup-restore.md](backup-restore.md)).

## Honest status

AccessLease is pre-release. The synthetic provider (labelled SYNTHETIC) and a real local PostgreSQL provider are the only providers. The fresh-operator smoke procedure has not yet been executed by a person other than the builders; that human receipt (acceptance criterion AC-11) is **pending**. Retention and backup defaults below are proposals that an operator must approve before real data is processed.
