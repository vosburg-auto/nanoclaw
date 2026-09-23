/**
 * Container runtime constants.
 *
 * This file used to claim that "all runtime-specific logic lives here so
 * swapping runtimes means changing one file" while the actual runtime logic —
 * spawn argv, mounts, hardening, kill/stop, orphan reaping — lived in
 * `container-runner.ts` and the egress module. That logic now lives behind the
 * driver seam (`src/drivers/`), which is what makes the claim true.
 *
 * What is left is the binary name, still needed by the few paths that shell
 * Docker for something that is not a session: per-group image builds and the
 * egress lockdown network.
 */
import os from 'os';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * CLI args needed for the container to resolve the host gateway.
 *
 * Fork patch (vosburg-auto): NANOCLAW_HOST_GATEWAY_IP points
 * host.docker.internal at a REMOTE host instead of this machine — for installs
 * where the services containers expect on "the host" (credential proxy,
 * notify endpoints) live on another box, e.g. nanoclaw relocated off the
 * OneCLI-gateway machine. Consumed by the Docker driver's network args
 * (src/drivers/index.ts).
 */
export function hostGatewayArgs(): string[] {
  const override = process.env.NANOCLAW_HOST_GATEWAY_IP;
  if (override) {
    return [`--add-host=host.docker.internal:${override}`];
  }
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}
