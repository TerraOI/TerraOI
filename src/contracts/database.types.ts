
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "budget_accounts": {
                  Row: {
                    "burst_per_user": number,"concurrent_run_cap": number,"daily_ceiling_units": number,"day_key": string,"day_reserved_units": number,"day_settled_units": number,"month_key": string,"month_reserved_units": number,"month_settled_units": number,"monthly_ceiling_units": number,"organisation_id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "burst_per_user": number,"concurrent_run_cap": number,"daily_ceiling_units": number,"day_key": string,"day_reserved_units"?: number,"day_settled_units"?: number,"month_key": string,"month_reserved_units"?: number,"month_settled_units"?: number,"monthly_ceiling_units": number,"organisation_id": string,"updated_at"?: string
                  }
                  Update: {
                    "burst_per_user"?: number,"concurrent_run_cap"?: number,"daily_ceiling_units"?: number,"day_key"?: string,"day_reserved_units"?: number,"day_settled_units"?: number,"month_key"?: string,"month_reserved_units"?: number,"month_settled_units"?: number,"monthly_ceiling_units"?: number,"organisation_id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "budget_accounts_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: true
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"budget_reservations": {
                  Row: {
                    "attempt_id": string,"created_at": string,"id": string,"max_units": number,"organisation_id": string,"provider_key": string,"reconciled_at": string | null,"run_id": string,"state": string,"task": string,"used_units": number | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id": string,"created_at"?: string,"id"?: string,"max_units": number,"organisation_id": string,"provider_key": string,"reconciled_at"?: string | null,"run_id": string,"state": string,"task": string,"used_units"?: number | null,"user_id"?: string | null
                  }
                  Update: {
                    "attempt_id"?: string,"created_at"?: string,"id"?: string,"max_units"?: number,"organisation_id"?: string,"provider_key"?: string,"reconciled_at"?: string | null,"run_id"?: string,"state"?: string,"task"?: string,"used_units"?: number | null,"user_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "budget_reservations_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "budget_reservations_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"chunk_embeddings": {
                  Row: {
                    "chunk_id": string,"created_at": string,"embedding": string,"id": string,"index_generation": number,"index_id": string,"organisation_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "chunk_id": string,"created_at"?: string,"embedding": string,"id"?: string,"index_generation": number,"index_id": string,"organisation_id": string
                  }
                  Update: {
                    "chunk_id"?: string,"created_at"?: string,"embedding"?: string,"id"?: string,"index_generation"?: number,"index_id"?: string,"organisation_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "chunk_embeddings_chunk_fk"
      columns: ["chunk_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_chunks"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "chunk_embeddings_index_fk"
      columns: ["index_id","organisation_id"]
isOneToOne: false
      referencedRelation: "embedding_indexes"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "chunk_embeddings_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"embedding_indexes": {
                  Row: {
                    "cleared_for": (string)[],"created_at": string,"dimensions": number,"generation": number,"id": string,"index_key": string,"metric": string,"model": string,"organisation_id": string,"provider_key": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "cleared_for"?: (string)[],"created_at"?: string,"dimensions": number,"generation": number,"id"?: string,"index_key": string,"metric": string,"model": string,"organisation_id": string,"provider_key": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "cleared_for"?: (string)[],"created_at"?: string,"dimensions"?: number,"generation"?: number,"id"?: string,"index_key"?: string,"metric"?: string,"model"?: string,"organisation_id"?: string,"provider_key"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "embedding_indexes_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"extraction_artifacts": {
                  Row: {
                    "artifact_index": number,"body_text": string,"confidence": number | null,"created_at": string,"data_class": string,"fence": number,"id": string,"index_generation": number,"job_id": string | null,"locator": NonNullable<Json>,"notes": NonNullable<Json>,"organisation_id": string,"parser_generation": string,"producer": string,"source_version_id": string,"stage": string
                  }
                  ComputedFields: never
                  Insert: {
                    "artifact_index": number,"body_text": string,"confidence"?: number | null,"created_at"?: string,"data_class": string,"fence": number,"id"?: string,"index_generation": number,"job_id"?: string | null,"locator"?: NonNullable<Json>,"notes"?: NonNullable<Json>,"organisation_id": string,"parser_generation": string,"producer": string,"source_version_id": string,"stage": string
                  }
                  Update: {
                    "artifact_index"?: number,"body_text"?: string,"confidence"?: number | null,"created_at"?: string,"data_class"?: string,"fence"?: number,"id"?: string,"index_generation"?: number,"job_id"?: string | null,"locator"?: NonNullable<Json>,"notes"?: NonNullable<Json>,"organisation_id"?: string,"parser_generation"?: string,"producer"?: string,"source_version_id"?: string,"stage"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "extraction_artifacts_job_fk"
      columns: ["job_id","organisation_id"]
isOneToOne: false
      referencedRelation: "ingestion_jobs"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "extraction_artifacts_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "extraction_artifacts_source_version_fk"
      columns: ["source_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"form_submissions": {
                  Row: {
                    "body_text": string | null,"created_at": string,"created_by": string,"id": string,"organisation_id": string,"project_id": string | null,"source_id": string | null,"source_version_id": string | null,"state": string,"supersedes_submission_id": string | null,"template_id": string,"template_version": string,"updated_at": string,"values_json": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "body_text"?: string | null,"created_at"?: string,"created_by": string,"id"?: string,"organisation_id": string,"project_id"?: string | null,"source_id"?: string | null,"source_version_id"?: string | null,"state"?: string,"supersedes_submission_id"?: string | null,"template_id": string,"template_version": string,"updated_at"?: string,"values_json": NonNullable<Json>
                  }
                  Update: {
                    "body_text"?: string | null,"created_at"?: string,"created_by"?: string,"id"?: string,"organisation_id"?: string,"project_id"?: string | null,"source_id"?: string | null,"source_version_id"?: string | null,"state"?: string,"supersedes_submission_id"?: string | null,"template_id"?: string,"template_version"?: string,"updated_at"?: string,"values_json"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "form_submissions_created_by_fk"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "form_submissions_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "form_submissions_project_fk"
      columns: ["project_id","organisation_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "form_submissions_source_fk"
      columns: ["source_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_sources"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "form_submissions_source_version_fk"
      columns: ["source_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "form_submissions_supersedes_fk"
      columns: ["supersedes_submission_id","organisation_id"]
isOneToOne: false
      referencedRelation: "form_submissions"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "form_submissions_template_fk"
      columns: ["template_id","organisation_id"]
isOneToOne: false
      referencedRelation: "form_templates"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "form_submissions_template_version_fk"
      columns: ["template_id","organisation_id","template_version"]
isOneToOne: false
      referencedRelation: "form_templates"
      referencedColumns: ["id","organisation_id","version"]
    }
                  ]
                },"form_templates": {
                  Row: {
                    "created_at": string,"data_class": string,"default_collection_id": string,"description": string | null,"id": string,"json_schema": NonNullable<Json>,"name": string,"organisation_id": string,"project_id": string | null,"published_at": string | null,"scope": string,"service_key": string,"status": string,"ui_hints": NonNullable<Json>,"updated_at": string,"version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"data_class": string,"default_collection_id": string,"description"?: string | null,"id"?: string,"json_schema": NonNullable<Json>,"name": string,"organisation_id": string,"project_id"?: string | null,"published_at"?: string | null,"scope": string,"service_key": string,"status"?: string,"ui_hints"?: NonNullable<Json>,"updated_at"?: string,"version": string
                  }
                  Update: {
                    "created_at"?: string,"data_class"?: string,"default_collection_id"?: string,"description"?: string | null,"id"?: string,"json_schema"?: NonNullable<Json>,"name"?: string,"organisation_id"?: string,"project_id"?: string | null,"published_at"?: string | null,"scope"?: string,"service_key"?: string,"status"?: string,"ui_hints"?: NonNullable<Json>,"updated_at"?: string,"version"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "form_templates_collection_fk"
      columns: ["default_collection_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_collections"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "form_templates_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "form_templates_project_fk"
      columns: ["project_id","organisation_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"ingestion_jobs": {
                  Row: {
                    "attempt": number,"completed_at": string | null,"created_at": string,"data_class": string,"executor": string,"id": string,"index_generation": number,"last_error": string | null,"lease_expires_at": string | null,"lease_fence": number,"lease_token": string | null,"organisation_id": string,"parser_generation": string,"source_version_id": string,"stage": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt"?: number,"completed_at"?: string | null,"created_at"?: string,"data_class": string,"executor": string,"id"?: string,"index_generation": number,"last_error"?: string | null,"lease_expires_at"?: string | null,"lease_fence"?: number,"lease_token"?: string | null,"organisation_id": string,"parser_generation"?: string,"source_version_id": string,"stage": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "attempt"?: number,"completed_at"?: string | null,"created_at"?: string,"data_class"?: string,"executor"?: string,"id"?: string,"index_generation"?: number,"last_error"?: string | null,"lease_expires_at"?: string | null,"lease_fence"?: number,"lease_token"?: string | null,"organisation_id"?: string,"parser_generation"?: string,"source_version_id"?: string,"stage"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ingestion_jobs_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "ingestion_jobs_source_version_fk"
      columns: ["source_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"knowledge_chunks": {
                  Row: {
                    "body_text": string,"chunk_index": number,"created_at": string,"data_class": string,"id": string,"locator": NonNullable<Json>,"organisation_id": string,"search_vector": unknown,"source_version_id": string,"token_count": number | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body_text": string,"chunk_index": number,"created_at"?: string,"data_class": string,"id"?: string,"locator"?: NonNullable<Json>,"organisation_id": string,"search_vector"?: never,"source_version_id": string,"token_count"?: number | null,"updated_at"?: string
                  }
                  Update: {
                    "body_text"?: string,"chunk_index"?: number,"created_at"?: string,"data_class"?: string,"id"?: string,"locator"?: NonNullable<Json>,"organisation_id"?: string,"search_vector"?: never,"source_version_id"?: string,"token_count"?: number | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "knowledge_chunks_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_chunks_source_version_fk"
      columns: ["source_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"knowledge_collections": {
                  Row: {
                    "created_at": string,"data_class": string,"id": string,"key": string,"name": string,"organisation_id": string,"project_id": string | null,"service_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"data_class": string,"id"?: string,"key": string,"name": string,"organisation_id": string,"project_id"?: string | null,"service_key": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"data_class"?: string,"id"?: string,"key"?: string,"name"?: string,"organisation_id"?: string,"project_id"?: string | null,"service_key"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "knowledge_collections_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_collections_project_fk"
      columns: ["project_id","organisation_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"knowledge_sources": {
                  Row: {
                    "collection_id": string,"created_at": string,"current_version_id": string | null,"deleted_at": string | null,"external_id": string | null,"id": string,"kind": string,"lifecycle_state": string,"organisation_id": string,"owner_user_id": string | null,"revoked_at": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "collection_id": string,"created_at"?: string,"current_version_id"?: string | null,"deleted_at"?: string | null,"external_id"?: string | null,"id"?: string,"kind": string,"lifecycle_state"?: string,"organisation_id": string,"owner_user_id"?: string | null,"revoked_at"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "collection_id"?: string,"created_at"?: string,"current_version_id"?: string | null,"deleted_at"?: string | null,"external_id"?: string | null,"id"?: string,"kind"?: string,"lifecycle_state"?: string,"organisation_id"?: string,"owner_user_id"?: string | null,"revoked_at"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "knowledge_sources_collection_fk"
      columns: ["collection_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_collections"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "knowledge_sources_current_version_fk"
      columns: ["current_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "knowledge_sources_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_sources_owner_user_id_fkey"
      columns: ["owner_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"knowledge_upload_sessions": {
                  Row: {
                    "collection_id": string,"created_at": string,"created_by": string,"expires_at": string,"filename": string,"id": string,"idempotency_key": string,"max_size_bytes": number,"object_ref": string,"organisation_id": string,"reason_code": string | null,"source_id": string | null,"source_version_id": string | null,"state": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "collection_id": string,"created_at"?: string,"created_by": string,"expires_at": string,"filename": string,"id"?: string,"idempotency_key": string,"max_size_bytes": number,"object_ref": string,"organisation_id": string,"reason_code"?: string | null,"source_id"?: string | null,"source_version_id"?: string | null,"state"?: string,"updated_at"?: string
                  }
                  Update: {
                    "collection_id"?: string,"created_at"?: string,"created_by"?: string,"expires_at"?: string,"filename"?: string,"id"?: string,"idempotency_key"?: string,"max_size_bytes"?: number,"object_ref"?: string,"organisation_id"?: string,"reason_code"?: string | null,"source_id"?: string | null,"source_version_id"?: string | null,"state"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "knowledge_upload_sessions_collection_fk"
      columns: ["collection_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_collections"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "knowledge_upload_sessions_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_upload_sessions_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_upload_sessions_source_fk"
      columns: ["source_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_sources"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "knowledge_upload_sessions_source_version_fk"
      columns: ["source_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"membership_roles": {
                  Row: {
                    "created_at": string,"id": string,"membership_id": string,"organisation_id": string,"role_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"membership_id": string,"organisation_id": string,"role_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"membership_id"?: string,"organisation_id"?: string,"role_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "membership_roles_membership_id_organisation_id_fkey"
      columns: ["membership_id","organisation_id"]
isOneToOne: false
      referencedRelation: "organisation_memberships"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "membership_roles_role_id_organisation_id_fkey"
      columns: ["role_id","organisation_id"]
isOneToOne: false
      referencedRelation: "organisation_roles"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"model_providers": {
                  Row: {
                    "capability_tier": string,"clearance_revision": number,"context_window_units": number | null,"cost_rank": number,"created_at": string,"enabled": boolean,"max_cleared_class": string,"model": string | null,"provider_key": string,"supports_structured_output": boolean,"updated_at": string,"verifier_eval_set_version": string | null,"verifier_model": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "capability_tier": string,"clearance_revision": number,"context_window_units"?: number | null,"cost_rank": number,"created_at"?: string,"enabled"?: boolean,"max_cleared_class": string,"model"?: string | null,"provider_key": string,"supports_structured_output"?: boolean,"updated_at"?: string,"verifier_eval_set_version"?: string | null,"verifier_model"?: string | null
                  }
                  Update: {
                    "capability_tier"?: string,"clearance_revision"?: number,"context_window_units"?: number | null,"cost_rank"?: number,"created_at"?: string,"enabled"?: boolean,"max_cleared_class"?: string,"model"?: string | null,"provider_key"?: string,"supports_structured_output"?: boolean,"updated_at"?: string,"verifier_eval_set_version"?: string | null,"verifier_model"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"organisation_memberships": {
                  Row: {
                    "created_at": string,"id": string,"invited_at": string,"joined_at": string | null,"organisation_id": string,"status": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"invited_at"?: string,"joined_at"?: string | null,"organisation_id": string,"status"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"invited_at"?: string,"joined_at"?: string | null,"organisation_id"?: string,"status"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organisation_memberships_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "organisation_memberships_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"organisation_roles": {
                  Row: {
                    "created_at": string,"id": string,"key": string,"name": string,"organisation_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"key": string,"name": string,"organisation_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"key"?: string,"name"?: string,"organisation_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organisation_roles_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"organisations": {
                  Row: {
                    "created_at": string,"display_name": string,"id": string,"locale": string,"policy_revision": number,"slug": string,"status": string,"timezone": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name": string,"id": string,"locale"?: string,"policy_revision"?: number,"slug": string,"status"?: string,"timezone"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string,"id"?: string,"locale"?: string,"policy_revision"?: number,"slug"?: string,"status"?: string,"timezone"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"outbox_events": {
                  Row: {
                    "aggregate_id": string,"aggregate_type": string,"created_at": string,"event_type": string,"id": string,"organisation_id": string,"payload": NonNullable<Json>,"processed_at": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "aggregate_id": string,"aggregate_type": string,"created_at"?: string,"event_type": string,"id"?: string,"organisation_id": string,"payload"?: NonNullable<Json>,"processed_at"?: string | null
                  }
                  Update: {
                    "aggregate_id"?: string,"aggregate_type"?: string,"created_at"?: string,"event_type"?: string,"id"?: string,"organisation_id"?: string,"payload"?: NonNullable<Json>,"processed_at"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "outbox_events_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"display_name": string | null,"email": string | null,"id": string,"is_platform_admin": boolean
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name"?: string | null,"email"?: string | null,"id": string,"is_platform_admin"?: boolean
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string | null,"email"?: string | null,"id"?: string,"is_platform_admin"?: boolean
                  }
                  Relationships: [
                    
                  ]
                },"project_memberships": {
                  Row: {
                    "created_at": string,"id": string,"organisation_id": string,"project_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"organisation_id": string,"project_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"organisation_id"?: string,"project_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "project_memberships_project_id_organisation_id_fkey"
      columns: ["project_id","organisation_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "project_memberships_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"projects": {
                  Row: {
                    "created_at": string,"id": string,"key": string,"name": string,"organisation_id": string,"status": string,"visibility": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"key": string,"name": string,"organisation_id": string,"status"?: string,"visibility"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"key"?: string,"name"?: string,"organisation_id"?: string,"status"?: string,"visibility"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "projects_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"provider_health": {
                  Row: {
                    "checked_at": string,"circuit_open": boolean,"id": number,"latency_ms": number | null,"observed_by": string | null,"provider_key": string,"quota_window_reset_at": string | null,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "checked_at"?: string,"circuit_open"?: boolean,"id"?: never,"latency_ms"?: number | null,"observed_by"?: string | null,"provider_key": string,"quota_window_reset_at"?: string | null,"status": string
                  }
                  Update: {
                    "checked_at"?: string,"circuit_open"?: boolean,"id"?: never,"latency_ms"?: number | null,"observed_by"?: string | null,"provider_key"?: string,"quota_window_reset_at"?: string | null,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "provider_health_provider_key_fkey"
      columns: ["provider_key"]
isOneToOne: false
      referencedRelation: "model_providers"
      referencedColumns: ["provider_key"]
    }
                  ]
                },"provider_routes": {
                  Row: {
                    "created_at": string,"id": number,"provider_key": string,"route_position": number,"task_class": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: never,"provider_key": string,"route_position": number,"task_class": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: never,"provider_key"?: string,"route_position"?: number,"task_class"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "provider_routes_provider_key_fkey"
      columns: ["provider_key"]
isOneToOne: false
      referencedRelation: "model_providers"
      referencedColumns: ["provider_key"]
    }
                  ]
                },"role_permissions": {
                  Row: {
                    "area": string,"created_at": string,"id": string,"level": string,"organisation_id": string,"role_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "area": string,"created_at"?: string,"id"?: string,"level": string,"organisation_id": string,"role_id": string
                  }
                  Update: {
                    "area"?: string,"created_at"?: string,"id"?: string,"level"?: string,"organisation_id"?: string,"role_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "role_permissions_role_id_organisation_id_fkey"
      columns: ["role_id","organisation_id"]
isOneToOne: false
      referencedRelation: "organisation_roles"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"source_versions": {
                  Row: {
                    "body_text": string | null,"collection_id": string,"content_hash": string,"created_at": string,"data_class": string,"failure_note": string | null,"id": string,"object_ref": string,"organisation_id": string,"parser_generation": string,"payload": Json | null,"published_at": string | null,"revoked_at": string | null,"source_id": string,"state": string,"updated_at": string,"uploaded_by": string,"version_number": number
                  }
                  ComputedFields: never
                  Insert: {
                    "body_text"?: string | null,"collection_id": string,"content_hash": string,"created_at"?: string,"data_class": string,"failure_note"?: string | null,"id"?: string,"object_ref": string,"organisation_id": string,"parser_generation"?: string,"payload"?: Json | null,"published_at"?: string | null,"revoked_at"?: string | null,"source_id": string,"state"?: string,"updated_at"?: string,"uploaded_by": string,"version_number": number
                  }
                  Update: {
                    "body_text"?: string | null,"collection_id"?: string,"content_hash"?: string,"created_at"?: string,"data_class"?: string,"failure_note"?: string | null,"id"?: string,"object_ref"?: string,"organisation_id"?: string,"parser_generation"?: string,"payload"?: Json | null,"published_at"?: string | null,"revoked_at"?: string | null,"source_id"?: string,"state"?: string,"updated_at"?: string,"uploaded_by"?: string,"version_number"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_versions_collection_fk"
      columns: ["collection_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_collections"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "source_versions_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_versions_source_fk"
      columns: ["source_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_sources"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "source_versions_uploaded_by_fkey"
      columns: ["uploaded_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_brand_assets": {
                  Row: {
                    "byte_size": number,"config_version": number,"content": string,"content_type": string,"created_at": string,"id": string,"name": string,"organisation_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "byte_size": number,"config_version": number,"content": string,"content_type": string,"created_at"?: string,"id"?: string,"name": string,"organisation_id": string
                  }
                  Update: {
                    "byte_size"?: number,"config_version"?: number,"content"?: string,"content_type"?: string,"created_at"?: string,"id"?: string,"name"?: string,"organisation_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_brand_assets_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_brands": {
                  Row: {
                    "accent_color": string,"config_version": number,"created_at": string,"descriptor": string,"display_name": string,"document_prefix": string,"email_reply_to": string | null,"email_sender_name": string,"favicon_asset_id": string | null,"id": string,"legal_name": string | null,"logo_asset_id": string | null,"mode": string,"on_primary_color": string,"organisation_id": string,"primary_color": string,"report_owner": string,"support_label": string,"support_url": string | null,"tagline": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accent_color": string,"config_version"?: number,"created_at"?: string,"descriptor": string,"display_name": string,"document_prefix": string,"email_reply_to"?: string | null,"email_sender_name": string,"favicon_asset_id"?: string | null,"id"?: string,"legal_name"?: string | null,"logo_asset_id"?: string | null,"mode": string,"on_primary_color": string,"organisation_id": string,"primary_color": string,"report_owner": string,"support_label": string,"support_url"?: string | null,"tagline": string,"updated_at"?: string
                  }
                  Update: {
                    "accent_color"?: string,"config_version"?: number,"created_at"?: string,"descriptor"?: string,"display_name"?: string,"document_prefix"?: string,"email_reply_to"?: string | null,"email_sender_name"?: string,"favicon_asset_id"?: string | null,"id"?: string,"legal_name"?: string | null,"logo_asset_id"?: string | null,"mode"?: string,"on_primary_color"?: string,"organisation_id"?: string,"primary_color"?: string,"report_owner"?: string,"support_label"?: string,"support_url"?: string | null,"tagline"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_brands_favicon_asset_fk"
      columns: ["favicon_asset_id","organisation_id"]
isOneToOne: false
      referencedRelation: "tenant_brand_assets"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "tenant_brands_logo_asset_fk"
      columns: ["logo_asset_id","organisation_id"]
isOneToOne: false
      referencedRelation: "tenant_brand_assets"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "tenant_brands_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: true
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_domains": {
                  Row: {
                    "created_at": string,"host": string,"id": string,"is_canonical": boolean,"kind": string,"organisation_id": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"host": string,"id"?: string,"is_canonical"?: boolean,"kind"?: string,"organisation_id": string,"status"?: string
                  }
                  Update: {
                    "created_at"?: string,"host"?: string,"id"?: string,"is_canonical"?: boolean,"kind"?: string,"organisation_id"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_domains_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"tenant_provider_policy": {
                  Row: {
                    "created_at": string,"data_class": string,"organisation_id": string,"provider_key": string,"recorded_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"data_class": string,"organisation_id": string,"provider_key": string,"recorded_by"?: string | null
                  }
                  Update: {
                    "created_at"?: string,"data_class"?: string,"organisation_id"?: string,"provider_key"?: string,"recorded_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_provider_policy_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tenant_provider_policy_provider_key_fkey"
      columns: ["provider_key"]
isOneToOne: false
      referencedRelation: "model_providers"
      referencedColumns: ["provider_key"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "add_project_member_v1":
{ Args: { "p_organisation_id": string,"p_project_id": string,"p_user_id": string }; Returns: undefined
                           },
"begin_upload_session_v1":
{ Args: { "p_collection_id": string,"p_declared_size_bytes": number,"p_filename": string,"p_idempotency_key": string,"p_organisation_id": string }; Returns: {
              "o_expires_at": string,"o_max_size_bytes": number,"o_object_ref": string,"o_reused": boolean,"o_session_id": string,"o_state": string
            }[]
                           },
"chunk_is_readable":
{ Args: { "p_chunk_id": string }; Returns: boolean
                           },
"clear_tenant_scope":
{ Args: Record<PropertyKey, never>; Returns: undefined
                           },
"collection_is_readable":
{ Args: { "p_collection_id": string }; Returns: boolean
                           },
"create_collection_v1":
{ Args: { "p_data_class": string,"p_key": string,"p_name": string,"p_organisation_id": string,"p_project_id": string,"p_service": string }; Returns: string
                           },
"create_project_v1":
{ Args: { "p_key": string,"p_name": string,"p_organisation_id": string,"p_visibility": string }; Returns: string
                           },
"current_membership_v1":
{ Args: { "p_organisation_id": string }; Returns: {
              "membership_id": string,"organisation_id": string,"status": string
            }[]
                           },
"current_organisation_id":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"current_policy_revision_v1":
{ Args: { "p_organisation_id": string }; Returns: number
                           },
"data_class_is_ingestible_in_m1":
{ Args: { "p_data_class": string }; Returns: boolean
                           },
"data_class_is_valid":
{ Args: { "p_data_class": string }; Returns: boolean
                           },
"data_class_rank":
{ Args: { "p_data_class": string }; Returns: number
                           },
"form_submission_body_text":
{ Args: { "p_ui_hints": Json,"p_values": Json }; Returns: string
                           },
"form_template_is_wellformed":
{ Args: { "p_json_schema": Json,"p_ui_hints": Json }; Returns: boolean
                           },
"form_template_value_is_safe":
{ Args: { "p_value": Json }; Returns: boolean
                           },
"form_values_reject_reason":
{ Args: { "p_json_schema": Json,"p_values": Json }; Returns: string
                           },
"get_tenant_brand_v1":
{ Args: { "p_organisation_id": string }; Returns: {
              "accent_color": string,"config_version": number,"descriptor": string,"display_name": string,"document_prefix": string,"email_reply_to": string,"email_sender_name": string,"favicon_asset_id": string,"legal_name": string,"logo_asset_id": string,"mode": string,"on_primary_color": string,"organisation_id": string,"primary_color": string,"report_owner": string,"support_label": string,"support_url": string,"tagline": string
            }[]
                           },
"grant_membership_role_v1":
{ Args: { "p_organisation_id": string,"p_role_id": string,"p_user_id": string }; Returns: undefined
                           },
"is_active_member":
{ Args: { "p_organisation_id": string }; Returns: boolean
                           },
"is_project_member":
{ Args: { "p_project_id": string }; Returns: boolean
                           },
"load_public_brand":
{ Args: { "p_host": string }; Returns: {
              "accent_color": string,"descriptor": string,"display_name": string,"document_prefix": string,"email_sender_name": string,"favicon_bytes": number,"favicon_path": string,"logo_bytes": number,"logo_path": string,"mode": string,"on_primary_color": string,"primary_color": string,"report_owner": string,"show_powered_by": boolean,"support_label": string,"support_url": string,"tagline": string
            }[]
                           },
"load_public_brand_asset":
{ Args: { "p_config_version": number,"p_host": string,"p_name": string }; Returns: {
              "byte_size": number,"content_base64": string,"content_type": string
            }[]
                           },
"put_tenant_brand_v1":
{ Args: { "p_assets": Json,"p_brand": Json,"p_organisation_id": string }; Returns: number
                           },
"record_upload_outcome_v1":
{ Args: { "p_organisation_id": string,"p_reason_code": string,"p_state": string,"p_upload_session_id": string }; Returns: undefined
                           },
"register_source_version_v1":
{ Args: { "p_content_hash": string,"p_media_type": string,"p_organisation_id": string,"p_size_bytes": number,"p_upload_session_id": string }; Returns: {
              "o_already_uploaded": boolean,"o_source_id": string,"o_source_version_id": string,"o_state": string
            }[]
                           },
"remove_project_member_v1":
{ Args: { "p_organisation_id": string,"p_project_id": string,"p_user_id": string }; Returns: undefined
                           },
"resolve_tenant_host":
{ Args: { "p_host": string }; Returns: {
              "host": string,"is_canonical": boolean,"organisation_id": string,"organisation_status": string
            }[]
                           },
"revoke_membership_role_v1":
{ Args: { "p_organisation_id": string,"p_role_id": string,"p_user_id": string }; Returns: undefined
                           },
"save_form_draft_v1":
{ Args: { "p_organisation_id": string,"p_supersedes_submission_id"?: string,"p_template_id": string,"p_template_version": string,"p_values": Json }; Returns: string
                           },
"search_corpus_v1":
{ Args: { "p_authority_filters": (string)[],"p_collection_ids": (string)[],"p_effective_on": string,"p_embedding_index_id": string,"p_limit": number,"p_organisation_id": string,"p_project_id": string,"p_query_embedding": string,"p_query_text": string,"p_service_keys": (string)[] }; Returns: {
              "o_body_text": string,"o_chunk_id": string,"o_chunk_index": number,"o_collection_id": string,"o_content_hash": string,"o_data_class": string,"o_diagnostics": Json,"o_evidence_kind": string,"o_exact_match": boolean,"o_index_generation": number,"o_lane": string,"o_lexical_rank": number,"o_locator": Json,"o_organisation_id": string,"o_project_id": string,"o_published_at": string,"o_rank": number,"o_result_status": string,"o_rrf_score": number,"o_service_key": string,"o_source_id": string,"o_source_version_id": string,"o_vector_rank": number
            }[]
                           },
"set_tenant_scope":
{ Args: { "p_organisation_id": string }; Returns: string
                           },
"source_is_readable":
{ Args: { "p_source_id": string }; Returns: boolean
                           },
"source_version_is_readable":
{ Args: { "p_source_version_id": string }; Returns: boolean
                           },
"submit_form_v1":
{ Args: { "p_organisation_id": string,"p_submission_id": string }; Returns: string
                           },
"update_collection_v1":
{ Args: { "p_collection_id": string,"p_name": string,"p_organisation_id": string }; Returns: undefined
                           },
"user_may_publish_into":
{ Args: { "p_collection_id": string }; Returns: boolean
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
