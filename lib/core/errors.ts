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

export class OfficialImportValidationError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super("official_import_validation", message, { cause });
  }
}

export class OfficialImportConflictError extends PipelineError {
  constructor(message: string) {
    super("official_import_conflict", message);
  }
}

export class DiscoveryValidationError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super("discovery_validation", message, { cause });
  }
}

export class DiscoveryTransitionError extends PipelineError {
  constructor(message: string) {
    super("discovery_transition", message);
  }
}

export class DiscoverySourceConflictError extends PipelineError {
  constructor(message: string) {
    super("discovery_source_conflict", message);
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

export class MigrationIntegrityError extends PipelineError {
  constructor(message: string) {
    super("migration_integrity", message);
  }
}

export class EditorialInputError extends PipelineError {
  constructor(message: string, cause?: unknown) {
    super("editorial_input", message, { cause });
  }
}

export class EditorialRecordNotFoundError extends PipelineError {
  constructor(message = "Editorial record was not found.") {
    super("editorial_not_found", message);
  }
}

export class EditorialTransitionConflictError extends PipelineError {
  constructor(message: string) {
    super("editorial_transition_conflict", message);
  }
}

export class EditorialReplayConflictError extends PipelineError {
  constructor(message: string) {
    super("editorial_replay_conflict", message);
  }
}

export class EditorialSubjectChangedError extends PipelineError {
  constructor(message: string) {
    super("editorial_subject_changed", message);
  }
}

export class LocalReviewDisabledError extends PipelineError {
  constructor() {
    super(
      "local_review_disabled",
      "The local editorial review workspace is disabled.",
    );
  }
}
