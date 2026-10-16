import { ProviderUnavailableError } from "../connectors/provider.js";

/**
 * Hard deadline for one provider call. A provider that goes silent must not stall the worker pass or outlive the job lease:
 * the call is reported as `provider_timeout` (an unknown outcome, never a success), so issuance reconciles by lookup and
 * revocation becomes REVOCATION_UNCONFIRMED with a retry. The deadlines are shorter than `jobLeaseSeconds`.
 */
export async function withDeadline<T>(ms: number, call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProviderUnavailableError("provider_timeout", `provider call exceeded its ${ms} ms deadline`)), ms);
  });
  try {
    return await Promise.race([call(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
