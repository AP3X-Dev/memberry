export const ADMISSION_SANDBOX_PROTOCOL_VERSION_V1 = '1.0.0' as const;
export const APPROVED_NODE_BASE_IMAGE_V1 =
  'node@sha256:7eb2c0c4b8cf6fd761f0e6a7fed8d3b8ad59186848f0eee59744e546f1b6a3e9' as const;

export const ADMISSION_SANDBOX_LIMITS_V1 = Object.freeze({
  cpu: '0.5',
  memory: '128m',
  pids: 32,
  timeoutMs: 5_000,
  inputBytes: 32_768,
  outputBytes: 32_768,
  stderrBytes: 1_024,
});

export type AdmissionSandboxFailureCodeV1 =
  | 'REQUEST_INVALID'
  | 'SOURCE_UNAVAILABLE'
  | 'ATTESTATION_INVALID'
  | 'EXECUTOR_UNAVAILABLE'
  | 'CLEANUP_FAILED'
  | 'TIME_LIMIT'
  | 'MEMORY_LIMIT'
  | 'OUTPUT_LIMIT'
  | 'STDERR_LIMIT'
  | 'PROTOCOL_STDERR'
  | 'PROTOCOL_INVALID'
  | 'PROCESS_FAILED';

const ADMISSION_WORKER_FAILURE_JSON_V1 = Object.freeze({
  inputInvalid: '{"protocolVersion":"1.0.0","ok":false,"failureCode":"INPUT_INVALID"}',
  inputUnreadable: '{"protocolVersion":"1.0.0","ok":false,"failureCode":"INPUT_UNREADABLE"}',
  sandboxPolicy: '{"protocolVersion":"1.0.0","ok":false,"failureCode":"SANDBOX_POLICY"}',
});

export function admissionWorkerFailureBytesV1(
  code: keyof typeof ADMISSION_WORKER_FAILURE_JSON_V1,
): Uint8Array {
  return new TextEncoder().encode(ADMISSION_WORKER_FAILURE_JSON_V1[code]);
}
