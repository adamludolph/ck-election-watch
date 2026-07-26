export class PipelineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class CandidateImportValidationError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super("candidate_import_validation", message, { cause });
  }
}

export class SourceCaptureValidationError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super("source_capture_validation", message, { cause });
  }
}

export class NormalizationEmptyError extends PipelineError {
  constructor(message = "The snapshot produced no eligible text blocks.") {
    super("normalization_empty", message);
  }
}

export class ExtractionSchemaError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super("extraction_schema", message, { cause });
  }
}

export class EvidenceMismatchError extends PipelineError {
  constructor(message: string) {
    super("evidence_mismatch", message);
  }
}

export class PublicationPolicyError extends PipelineError {
  constructor(message: string) {
    super("publication_policy", message);
  }
}

export class DatabasePreparationError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super("database_preparation", message, { cause });
  }
}
