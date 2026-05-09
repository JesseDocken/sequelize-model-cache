export class ConfigurationError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, {
      cause,
    });
  }
}
