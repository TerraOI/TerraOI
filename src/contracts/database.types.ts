
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
            "agent_run_evidence": {
                  Row: {
                    "chunk_id": string | null,"claim_id": string,"created_at": string,"data_class": string,"evidence_kind": string,"field_path": string | null,"id": string,"observed_at": string | null,"organisation_id": string,"quoted_text": string | null,"record_id": string | null,"record_type": string | null,"record_version": number | null,"run_id": string,"source_version_id": string | null,"span_end_char": number | null,"span_start_char": number | null,"submission_id": string | null,"template_version": string | null,"tool_call_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "chunk_id"?: string | null,"claim_id": string,"created_at"?: string,"data_class": string,"evidence_kind": string,"field_path"?: string | null,"id"?: string,"observed_at"?: string | null,"organisation_id": string,"quoted_text"?: string | null,"record_id"?: string | null,"record_type"?: string | null,"record_version"?: number | null,"run_id": string,"source_version_id"?: string | null,"span_end_char"?: number | null,"span_start_char"?: number | null,"submission_id"?: string | null,"template_version"?: string | null,"tool_call_id"?: string | null
                  }
                  Update: {
                    "chunk_id"?: string | null,"claim_id"?: string,"created_at"?: string,"data_class"?: string,"evidence_kind"?: string,"field_path"?: string | null,"id"?: string,"observed_at"?: string | null,"organisation_id"?: string,"quoted_text"?: string | null,"record_id"?: string | null,"record_type"?: string | null,"record_version"?: number | null,"run_id"?: string,"source_version_id"?: string | null,"span_end_char"?: number | null,"span_start_char"?: number | null,"submission_id"?: string | null,"template_version"?: string | null,"tool_call_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_run_evidence_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_run_evidence_run_fk"
      columns: ["run_id","organisation_id"]
isOneToOne: false
      referencedRelation: "agent_runs"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "agent_run_evidence_source_version_fk"
      columns: ["source_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"agent_runs": {
                  Row: {
                    "answer_json": Json | null,"answer_status": string | null,"as_of": string | null,"completed_at": string | null,"conversation_id": string,"corpus_generations": (number)[] | null,"data_class": string,"expert_key": string,"expert_versions": (string)[] | null,"id": string,"idempotency_key": string,"organisation_id": string,"policy_revision": number,"refusal_reason": string | null,"requested_by": string,"started_at": string,"status": string,"user_message_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "answer_json"?: Json | null,"answer_status"?: string | null,"as_of"?: string | null,"completed_at"?: string | null,"conversation_id": string,"corpus_generations"?: (number)[] | null,"data_class": string,"expert_key": string,"expert_versions"?: (string)[] | null,"id": string,"idempotency_key": string,"organisation_id": string,"policy_revision": number,"refusal_reason"?: string | null,"requested_by": string,"started_at"?: string,"status"?: string,"user_message_id"?: string | null
                  }
                  Update: {
                    "answer_json"?: Json | null,"answer_status"?: string | null,"as_of"?: string | null,"completed_at"?: string | null,"conversation_id"?: string,"corpus_generations"?: (number)[] | null,"data_class"?: string,"expert_key"?: string,"expert_versions"?: (string)[] | null,"id"?: string,"idempotency_key"?: string,"organisation_id"?: string,"policy_revision"?: number,"refusal_reason"?: string | null,"requested_by"?: string,"started_at"?: string,"status"?: string,"user_message_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_runs_conversation_fk"
      columns: ["conversation_id","organisation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "agent_runs_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_runs_requested_by_fkey"
      columns: ["requested_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_runs_user_message_fk"
      columns: ["user_message_id","organisation_id"]
isOneToOne: false
      referencedRelation: "messages"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"budget_accounts": {
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
                    "attempt_id": string,"created_at": string,"day_key": string,"id": string,"max_units": number,"month_key": string,"organisation_id": string,"provider_key": string,"reconciled_at": string | null,"run_id": string,"state": string,"task": string,"used_units": number | null,"user_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_id": string,"created_at"?: string,"day_key": string,"id"?: string,"max_units": number,"month_key": string,"organisation_id": string,"provider_key": string,"reconciled_at"?: string | null,"run_id": string,"state": string,"task": string,"used_units"?: number | null,"user_id"?: string | null
                  }
                  Update: {
                    "attempt_id"?: string,"created_at"?: string,"day_key"?: string,"id"?: string,"max_units"?: number,"month_key"?: string,"organisation_id"?: string,"provider_key"?: string,"reconciled_at"?: string | null,"run_id"?: string,"state"?: string,"task"?: string,"used_units"?: number | null,"user_id"?: string | null
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
                },"conversations": {
                  Row: {
                    "created_at": string,"expert_key": string,"id": string,"last_activity_at": string,"organisation_id": string,"project_id": string | null,"status": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"expert_key": string,"id": string,"last_activity_at"?: string,"organisation_id": string,"project_id"?: string | null,"status"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"expert_key"?: string,"id"?: string,"last_activity_at"?: string,"organisation_id"?: string,"project_id"?: string | null,"status"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "conversations_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "conversations_project_fk"
      columns: ["project_id","organisation_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "conversations_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
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
                },"eval_cases": {
                  Row: {
                    "approved_at": string | null,"approved_by": string | null,"case_key": string,"case_type": string,"created_at": string,"created_by": string,"data_class": string,"derived_from_message_id": string | null,"derived_from_run_id": string | null,"drafted_by": string,"drafted_on": string,"expert_key": string,"id": string,"organisation_id": string,"origin": string,"payload": NonNullable<Json>,"question": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"case_key": string,"case_type": string,"created_at"?: string,"created_by": string,"data_class": string,"derived_from_message_id"?: string | null,"derived_from_run_id"?: string | null,"drafted_by": string,"drafted_on": string,"expert_key": string,"id"?: string,"organisation_id": string,"origin": string,"payload"?: NonNullable<Json>,"question": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "approved_at"?: string | null,"approved_by"?: string | null,"case_key"?: string,"case_type"?: string,"created_at"?: string,"created_by"?: string,"data_class"?: string,"derived_from_message_id"?: string | null,"derived_from_run_id"?: string | null,"drafted_by"?: string,"drafted_on"?: string,"expert_key"?: string,"id"?: string,"organisation_id"?: string,"origin"?: string,"payload"?: NonNullable<Json>,"question"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "eval_cases_approved_by_fkey"
      columns: ["approved_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "eval_cases_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "eval_cases_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"eval_results": {
                  Row: {
                    "case_id": string,"created_at": string,"evidence": NonNullable<Json>,"failure_class": string | null,"id": string,"organisation_id": string,"run_id": string,"score": number | null
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"created_at"?: string,"evidence"?: NonNullable<Json>,"failure_class"?: string | null,"id"?: string,"organisation_id": string,"run_id": string,"score"?: number | null
                  }
                  Update: {
                    "case_id"?: string,"created_at"?: string,"evidence"?: NonNullable<Json>,"failure_class"?: string | null,"id"?: string,"organisation_id"?: string,"run_id"?: string,"score"?: number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "eval_results_case_fk"
      columns: ["case_id","organisation_id"]
isOneToOne: false
      referencedRelation: "eval_cases"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "eval_results_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "eval_results_run_fk"
      columns: ["run_id","organisation_id"]
isOneToOne: false
      referencedRelation: "eval_runs"
      referencedColumns: ["id","organisation_id"]
    }
                  ]
                },"eval_reviews": {
                  Row: {
                    "case_id": string,"created_at": string,"decision": string,"edits": NonNullable<Json>,"id": string,"organisation_id": string,"reviewer_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "case_id": string,"created_at"?: string,"decision": string,"edits"?: NonNullable<Json>,"id"?: string,"organisation_id": string,"reviewer_id": string
                  }
                  Update: {
                    "case_id"?: string,"created_at"?: string,"decision"?: string,"edits"?: NonNullable<Json>,"id"?: string,"organisation_id"?: string,"reviewer_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "eval_reviews_case_fk"
      columns: ["case_id","organisation_id"]
isOneToOne: false
      referencedRelation: "eval_cases"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "eval_reviews_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "eval_reviews_reviewer_id_fkey"
      columns: ["reviewer_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"eval_runs": {
                  Row: {
                    "chain_config": NonNullable<Json>,"corpus_generation": string,"created_at": string,"expert_key": string,"expert_version": string,"finished_at": string | null,"id": string,"organisation_id": string,"started_at": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "chain_config"?: NonNullable<Json>,"corpus_generation": string,"created_at"?: string,"expert_key": string,"expert_version": string,"finished_at"?: string | null,"id"?: string,"organisation_id": string,"started_at"?: string,"status"?: string
                  }
                  Update: {
                    "chain_config"?: NonNullable<Json>,"corpus_generation"?: string,"created_at"?: string,"expert_key"?: string,"expert_version"?: string,"finished_at"?: string | null,"id"?: string,"organisation_id"?: string,"started_at"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "eval_runs_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"expert_definitions": {
                  Row: {
                    "answer_schema_version": string,"clarification_policy": string,"created_at": string,"embedding_index_key": string,"evaluation_set_version": string,"expert_key": string,"instruction_template_version": string,"limits": NonNullable<Json>,"min_verifier_tier": string,"model_chains": NonNullable<Json>,"prompt_template_id": string,"prompt_template_version": string,"published_at": string | null,"refusal_templates": NonNullable<Json>,"retrieval_profile_version": string,"risk_class": string,"service_key": string,"status": string,"tool_keys": (string)[],"updated_at": string,"version": string,"withdrawn_at": string | null,"workflow_keys": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "answer_schema_version": string,"clarification_policy": string,"created_at"?: string,"embedding_index_key": string,"evaluation_set_version": string,"expert_key": string,"instruction_template_version": string,"limits": NonNullable<Json>,"min_verifier_tier": string,"model_chains": NonNullable<Json>,"prompt_template_id": string,"prompt_template_version": string,"published_at"?: string | null,"refusal_templates": NonNullable<Json>,"retrieval_profile_version": string,"risk_class": string,"service_key": string,"status"?: string,"tool_keys"?: (string)[],"updated_at"?: string,"version": string,"withdrawn_at"?: string | null,"workflow_keys"?: (string)[]
                  }
                  Update: {
                    "answer_schema_version"?: string,"clarification_policy"?: string,"created_at"?: string,"embedding_index_key"?: string,"evaluation_set_version"?: string,"expert_key"?: string,"instruction_template_version"?: string,"limits"?: NonNullable<Json>,"min_verifier_tier"?: string,"model_chains"?: NonNullable<Json>,"prompt_template_id"?: string,"prompt_template_version"?: string,"published_at"?: string | null,"refusal_templates"?: NonNullable<Json>,"retrieval_profile_version"?: string,"risk_class"?: string,"service_key"?: string,"status"?: string,"tool_keys"?: (string)[],"updated_at"?: string,"version"?: string,"withdrawn_at"?: string | null,"workflow_keys"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "expert_definitions_prompt_fk"
      columns: ["prompt_template_id","prompt_template_version"]
isOneToOne: false
      referencedRelation: "prompt_templates"
      referencedColumns: ["id","version"]
    },{
      foreignKeyName: "expert_definitions_service_key_fkey"
      columns: ["service_key"]
isOneToOne: false
      referencedRelation: "service_definitions"
      referencedColumns: ["service_key"]
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
                    "auto_publish": boolean,"created_at": string,"data_class": string,"id": string,"key": string,"name": string,"organisation_id": string,"project_id": string | null,"review_independent": boolean,"service_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "auto_publish"?: boolean,"created_at"?: string,"data_class": string,"id"?: string,"key": string,"name": string,"organisation_id": string,"project_id"?: string | null,"review_independent"?: boolean,"service_key": string,"updated_at"?: string
                  }
                  Update: {
                    "auto_publish"?: boolean,"created_at"?: string,"data_class"?: string,"id"?: string,"key"?: string,"name"?: string,"organisation_id"?: string,"project_id"?: string | null,"review_independent"?: boolean,"service_key"?: string,"updated_at"?: string
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
                },"knowledge_review_decisions": {
                  Row: {
                    "decided_at": string,"decision": string,"id": string,"organisation_id": string,"reason": string | null,"reviewer_user_id": string,"source_version_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "decided_at"?: string,"decision": string,"id"?: string,"organisation_id": string,"reason"?: string | null,"reviewer_user_id": string,"source_version_id": string
                  }
                  Update: {
                    "decided_at"?: string,"decision"?: string,"id"?: string,"organisation_id"?: string,"reason"?: string | null,"reviewer_user_id"?: string,"source_version_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "knowledge_review_decisions_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_review_decisions_reviewer_user_id_fkey"
      columns: ["reviewer_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_review_decisions_version_fk"
      columns: ["source_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
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
                },"knowledge_submissions": {
                  Row: {
                    "agent_run_id": string | null,"author_user_id": string,"cited_source_version_ids": (string)[],"collection_id": string,"created_at": string,"data_class": string,"id": string,"kind": string,"organisation_id": string,"project_id": string | null,"proposed_text": string,"review_by": string | null,"review_reason": string | null,"reviewed_at": string | null,"reviewer_user_id": string | null,"source_id": string | null,"source_version_id": string | null,"state": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_run_id"?: string | null,"author_user_id": string,"cited_source_version_ids"?: (string)[],"collection_id": string,"created_at"?: string,"data_class": string,"id"?: string,"kind": string,"organisation_id": string,"project_id"?: string | null,"proposed_text": string,"review_by"?: string | null,"review_reason"?: string | null,"reviewed_at"?: string | null,"reviewer_user_id"?: string | null,"source_id"?: string | null,"source_version_id"?: string | null,"state"?: string,"updated_at"?: string
                  }
                  Update: {
                    "agent_run_id"?: string | null,"author_user_id"?: string,"cited_source_version_ids"?: (string)[],"collection_id"?: string,"created_at"?: string,"data_class"?: string,"id"?: string,"kind"?: string,"organisation_id"?: string,"project_id"?: string | null,"proposed_text"?: string,"review_by"?: string | null,"review_reason"?: string | null,"reviewed_at"?: string | null,"reviewer_user_id"?: string | null,"source_id"?: string | null,"source_version_id"?: string | null,"state"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "knowledge_submissions_author_fk"
      columns: ["author_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_submissions_collection_fk"
      columns: ["collection_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_collections"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "knowledge_submissions_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_submissions_project_fk"
      columns: ["project_id","organisation_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "knowledge_submissions_reviewer_fk"
      columns: ["reviewer_user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "knowledge_submissions_source_fk"
      columns: ["source_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_sources"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "knowledge_submissions_source_version_fk"
      columns: ["source_version_id","organisation_id"]
isOneToOne: false
      referencedRelation: "source_versions"
      referencedColumns: ["id","organisation_id"]
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
                },"messages": {
                  Row: {
                    "body_text": string,"client_message_id": string | null,"conversation_id": string,"created_at": string,"data_class": string,"id": string,"organisation_id": string,"role": string,"run_id": string | null,"seq": number
                  }
                  ComputedFields: never
                  Insert: {
                    "body_text": string,"client_message_id"?: string | null,"conversation_id": string,"created_at"?: string,"data_class": string,"id"?: string,"organisation_id": string,"role": string,"run_id"?: string | null,"seq"?: never
                  }
                  Update: {
                    "body_text"?: string,"client_message_id"?: string | null,"conversation_id"?: string,"created_at"?: string,"data_class"?: string,"id"?: string,"organisation_id"?: string,"role"?: string,"run_id"?: string | null,"seq"?: never
                  }
                  Relationships: [
                    {
      foreignKeyName: "messages_conversation_fk"
      columns: ["conversation_id","organisation_id"]
isOneToOne: false
      referencedRelation: "conversations"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "messages_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "messages_run_fk"
      columns: ["run_id","organisation_id"]
isOneToOne: false
      referencedRelation: "agent_runs"
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
                },"prompt_templates": {
                  Row: {
                    "body": string,"body_hash": string,"created_at": string,"id": string,"owner": string,"published_at": string | null,"status": string,"updated_at": string,"version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body": string,"body_hash": string,"created_at"?: string,"id": string,"owner": string,"published_at"?: string | null,"status"?: string,"updated_at"?: string,"version": string
                  }
                  Update: {
                    "body"?: string,"body_hash"?: string,"created_at"?: string,"id"?: string,"owner"?: string,"published_at"?: string | null,"status"?: string,"updated_at"?: string,"version"?: string
                  }
                  Relationships: [
                    
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
                },"service_definitions": {
                  Row: {
                    "created_at": string,"description": string,"display_name": string,"manifest_version": string,"service_key": string,"status": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description": string,"display_name": string,"manifest_version": string,"service_key": string,"status"?: string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string,"display_name"?: string,"manifest_version"?: string,"service_key"?: string,"status"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"source_acl_bindings": {
                  Row: {
                    "created_at": string,"id": string,"organisation_id": string,"project_id": string,"source_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"organisation_id": string,"project_id": string,"source_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"organisation_id"?: string,"project_id"?: string,"source_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "source_acl_bindings_organisation_fk"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "source_acl_bindings_project_fk"
      columns: ["project_id","organisation_id"]
isOneToOne: false
      referencedRelation: "projects"
      referencedColumns: ["id","organisation_id"]
    },{
      foreignKeyName: "source_acl_bindings_source_fk"
      columns: ["source_id","organisation_id"]
isOneToOne: false
      referencedRelation: "knowledge_sources"
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
                },"tenant_experts": {
                  Row: {
                    "collection_bindings": (string)[],"created_at": string,"enabled": boolean,"expert_key": string,"expert_version": string,"id": string,"organisation_id": string,"service_key": string,"updated_at": string,"vocabulary_override": NonNullable<Json>
                  }
                  ComputedFields: never
                  Insert: {
                    "collection_bindings"?: (string)[],"created_at"?: string,"enabled"?: boolean,"expert_key": string,"expert_version": string,"id"?: string,"organisation_id": string,"service_key": string,"updated_at"?: string,"vocabulary_override"?: NonNullable<Json>
                  }
                  Update: {
                    "collection_bindings"?: (string)[],"created_at"?: string,"enabled"?: boolean,"expert_key"?: string,"expert_version"?: string,"id"?: string,"organisation_id"?: string,"service_key"?: string,"updated_at"?: string,"vocabulary_override"?: NonNullable<Json>
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_experts_definition_fk"
      columns: ["expert_key","expert_version","service_key"]
isOneToOne: false
      referencedRelation: "expert_definitions"
      referencedColumns: ["expert_key","version","service_key"]
    },{
      foreignKeyName: "tenant_experts_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tenant_experts_service_fk"
      columns: ["organisation_id","service_key"]
isOneToOne: false
      referencedRelation: "tenant_services"
      referencedColumns: ["organisation_id","service_key"]
    }
                  ]
                },"tenant_invitations": {
                  Row: {
                    "created_at": string,"email": string,"expires_at": string,"id": string,"invited_by": string,"organisation_id": string,"role_id": string,"status": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"email": string,"expires_at": string,"id"?: string,"invited_by": string,"organisation_id": string,"role_id": string,"status"?: string
                  }
                  Update: {
                    "created_at"?: string,"email"?: string,"expires_at"?: string,"id"?: string,"invited_by"?: string,"organisation_id"?: string,"role_id"?: string,"status"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_invitations_invited_by_fkey"
      columns: ["invited_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tenant_invitations_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tenant_invitations_role_id_organisation_id_fkey"
      columns: ["role_id","organisation_id"]
isOneToOne: false
      referencedRelation: "organisation_roles"
      referencedColumns: ["id","organisation_id"]
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
                },"tenant_services": {
                  Row: {
                    "created_at": string,"enabled": boolean,"entitled_at": string,"id": string,"organisation_id": string,"service_key": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"enabled"?: boolean,"entitled_at"?: string,"id"?: string,"organisation_id": string,"service_key": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"enabled"?: boolean,"entitled_at"?: string,"id"?: string,"organisation_id"?: string,"service_key"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenant_services_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tenant_services_service_key_fkey"
      columns: ["service_key"]
isOneToOne: false
      referencedRelation: "service_definitions"
      referencedColumns: ["service_key"]
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
"authorize_source_access_v1":
{ Args: { "p_organisation_id": string,"p_purpose": string,"p_source_id": string }; Returns: boolean
                           },
"begin_upload_session_v1":
{ Args: { "p_collection_id": string,"p_declared_size_bytes": number,"p_filename": string,"p_idempotency_key": string,"p_organisation_id": string }; Returns: {
              "o_expires_at": string,"o_max_size_bytes": number,"o_object_ref": string,"o_reused": boolean,"o_session_id": string,"o_state": string
            }[]
                           },
"chat_actor_may_ask":
{ Args: { "p_organisation_id": string }; Returns: boolean
                           },
"chat_append_user_message_v1":
{ Args: { "p_body_text": string,"p_client_message_id": string,"p_conversation_id": string,"p_data_class": string,"p_organisation_id": string }; Returns: string
                           },
"chat_complete_run_v1":
{ Args: { "p_answer": Json,"p_organisation_id": string,"p_run_id": string }; Returns: Json
                           },
"chat_conversation_owned":
{ Args: { "p_conversation_id": string }; Returns: boolean
                           },
"chat_ensure_conversation_v1":
{ Args: { "p_conversation_id": string,"p_expert_key": string,"p_organisation_id": string,"p_project_id": string }; Returns: string
                           },
"chat_get_run_v1":
{ Args: { "p_organisation_id": string,"p_run_id": string }; Returns: Json
                           },
"chat_int_array_is_positive":
{ Args: { "p_values": (number)[] }; Returns: boolean
                           },
"chat_json_has_forbidden_key":
{ Args: { "p_depth"?: number,"p_value": Json }; Returns: boolean
                           },
"chat_list_conversations_v1":
{ Args: { "p_limit": number,"p_organisation_id": string }; Returns: Json
                           },
"chat_load_conversation_v1":
{ Args: { "p_conversation_id": string,"p_organisation_id": string }; Returns: Json
                           },
"chat_run_answer_withheld":
{ Args: { "p_run_id": string }; Returns: boolean
                           },
"chat_start_run_v1":
{ Args: { "p_conversation_id": string,"p_data_class": string,"p_expert_key": string,"p_idempotency_key": string,"p_organisation_id": string,"p_run_id": string,"p_user_message_id": string }; Returns: string
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
"create_eval_case_draft_v1":
{ Args: { "p_body": Json,"p_organisation_id": string }; Returns: string
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
"exact_lookup_v1":
{ Args: { "p_collection_ids": (string)[],"p_identifier": string,"p_limit": number,"p_organisation_id": string,"p_project_id": string,"p_service_keys": (string)[] }; Returns: {
              "o_body_text": string,"o_chunk_id": string,"o_chunk_index": number,"o_collection_id": string,"o_content_hash": string,"o_data_class": string,"o_locator": Json,"o_match_kind": string,"o_organisation_id": string,"o_project_id": string,"o_published_at": string,"o_rank": number,"o_service_key": string,"o_source_id": string,"o_source_version_id": string
            }[]
                           },
"expert_chain_follows_order":
{ Args: { "p_chain": Json,"p_order": (string)[] }; Returns: boolean
                           },
"expert_limits_are_valid":
{ Args: { "p_limits": Json }; Returns: boolean
                           },
"expert_model_chains_are_valid":
{ Args: { "p_chains": Json }; Returns: boolean
                           },
"expert_refusal_templates_are_valid":
{ Args: { "p_templates": Json }; Returns: boolean
                           },
"export_approved_eval_cases_v1":
{ Args: { "p_organisation_id": string }; Returns: {
              "approved_at": string,"approved_by": string,"case_key": string,"data_class": string,"expert_key": string,"id": string,"origin": string,"payload": Json,"question": string
            }[]
                           },
"find_upload_session_v1":
{ Args: { "p_organisation_id": string,"p_upload_session_id": string }; Returns: {
              "o_collection_id": string,"o_created_at": string,"o_created_by": string,"o_expires_at": string,"o_idempotency_key": string,"o_max_size_bytes": number,"o_object_ref": string,"o_organisation_id": string,"o_reason_code": string,"o_session_id": string,"o_source_id": string,"o_source_version_id": string,"o_state": string
            }[]
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
"get_form_template_v1":
{ Args: { "p_organisation_id": string,"p_template_id": string }; Returns: {
              "data_class": string,"default_collection_id": string,"description": string,"id": string,"json_schema": Json,"name": string,"organisation_id": string,"project_id": string,"published_at": string,"scope": string,"service_key": string,"status": string,"ui_hints": Json,"version": string
            }[]
                           },
"get_tenant_brand_v1":
{ Args: { "p_organisation_id": string }; Returns: {
              "accent_color": string,"config_version": number,"descriptor": string,"display_name": string,"document_prefix": string,"email_reply_to": string,"email_sender_name": string,"favicon_asset_id": string,"legal_name": string,"logo_asset_id": string,"mode": string,"on_primary_color": string,"organisation_id": string,"primary_color": string,"report_owner": string,"support_label": string,"support_url": string,"tagline": string
            }[]
                           },
"grant_membership_role_v1":
{ Args: { "p_organisation_id": string,"p_role_id": string,"p_user_id": string }; Returns: undefined
                           },
"invite_member_v1":
{ Args: { "p_email": string,"p_organisation_id": string,"p_role_id": string }; Returns: string
                           },
"is_active_member":
{ Args: { "p_organisation_id": string }; Returns: boolean
                           },
"is_project_member":
{ Args: { "p_project_id": string }; Returns: boolean
                           },
"list_eval_cases_v1":
{ Args: { "p_organisation_id": string,"p_status": string }; Returns: {
              "approved_at": string,"approved_by": string,"case_key": string,"case_type": string,"created_by": string,"data_class": string,"expert_key": string,"id": string,"origin": string,"question": string,"status": string
            }[]
                           },
"list_form_templates_v1":
{ Args: { "p_organisation_id": string }; Returns: {
              "data_class": string,"default_collection_id": string,"description": string,"id": string,"json_schema": Json,"name": string,"organisation_id": string,"project_id": string,"published_at": string,"scope": string,"service_key": string,"status": string,"ui_hints": Json,"version": string
            }[]
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
"member_has_evals_review":
{ Args: { "p_min_level": string,"p_organisation_id": string }; Returns: boolean
                           },
"publish_knowledge_version_v1":
{ Args: { "p_organisation_id": string,"p_source_version_id": string }; Returns: string
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
"review_decision_v1":
{ Args: { "p_decision": string,"p_organisation_id": string,"p_reason"?: string,"p_source_version_id": string }; Returns: string
                           },
"review_eval_case_v1":
{ Args: { "p_case_id": string,"p_decision": string,"p_edits": Json,"p_organisation_id": string }; Returns: undefined
                           },
"review_knowledge_submission_v1":
{ Args: { "p_decision": string,"p_organisation_id": string,"p_reason"?: string,"p_submission_id": string }; Returns: string
                           },
"revoke_membership_role_v1":
{ Args: { "p_organisation_id": string,"p_role_id": string,"p_user_id": string }; Returns: undefined
                           },
"revoke_source_v1":
{ Args: { "p_organisation_id": string,"p_reason"?: string,"p_source_id": string }; Returns: undefined
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
"source_audience_allows":
{ Args: { "p_source_id": string }; Returns: boolean
                           },
"source_is_readable":
{ Args: { "p_source_id": string }; Returns: boolean
                           },
"source_version_is_readable":
{ Args: { "p_source_version_id": string }; Returns: boolean
                           },
"submit_employee_knowledge_v1":
{ Args: { "p_agent_run_id"?: string,"p_cited_source_version_ids"?: (string)[],"p_collection_id": string,"p_context_data_class": string,"p_kind": string,"p_organisation_id": string,"p_proposed_text": string,"p_review_by"?: string }; Returns: string
                           },
"submit_form_v1":
{ Args: { "p_organisation_id": string,"p_submission_id": string }; Returns: string
                           },
"tenant_vocabulary_override_is_valid":
{ Args: { "p_override": Json }; Returns: boolean
                           },
"update_collection_v1":
{ Args: { "p_collection_id": string,"p_name": string,"p_organisation_id": string }; Returns: undefined
                           },
"user_in_collection_audience":
{ Args: { "p_collection_id": string }; Returns: boolean
                           },
"user_may_access_knowledge_object":
{ Args: { "p_object_name": string }; Returns: boolean
                           },
"user_may_publish_into":
{ Args: { "p_collection_id": string }; Returns: boolean
                           },
"user_may_review_knowledge":
{ Args: { "p_organisation_id": string }; Returns: boolean
                           },
"withdraw_knowledge_submission_v1":
{ Args: { "p_organisation_id": string,"p_submission_id": string }; Returns: string
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
