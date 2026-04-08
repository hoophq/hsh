export interface Plugin {
  /** Plugin identifier (e.g., "ssh", "kubectl") */
  name: string;

  /** Human-readable description */
  description: string;

  /** The native command this plugin wraps (e.g., "ssh", "kubectl") */
  wrappedCommand: string;

  /** Execute the plugin with the original command arguments */
  run(args: string[]): Promise<void>;
}
