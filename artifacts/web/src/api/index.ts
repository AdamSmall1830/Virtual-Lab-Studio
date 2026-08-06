// Central API surface for the app — thin aliases over the generated
// OpenAPI React Query client (lib/api-client-react), which talks to the
// real FastAPI backend at `${BASE_URL}api/v1/...`.
//
// All server state flows through these hooks; there is no client-side
// demo store any more.

export * from '@workspace/api-client-react';

export {
  // auth/session
  useMeApiV1MeGet as useMe,
  getMeApiV1MeGetQueryKey as getMeQueryKey,
  useDevLoginApiV1AuthDevLoginPost as useDevLogin,
  useLogoutApiV1AuthLogoutPost as useLogout,
  // workspace-scoped resources
  useListWorkspacesApiV1WorkspacesGet as useWorkspaces,
  useListProjectsApiV1WorkspacesWorkspaceIdProjectsGet as useProjects,
  getListProjectsApiV1WorkspacesWorkspaceIdProjectsGetQueryKey as getProjectsQueryKey,
  useGetProjectApiV1ProjectsProjectIdGet as useProject,
  useCreateProjectApiV1WorkspacesWorkspaceIdProjectsPost as useCreateProject,
  useListAgentsApiV1WorkspacesWorkspaceIdAgentsGet as useAgents,
  useListTemplatesApiV1WorkspacesWorkspaceIdTemplatesGet as useTemplates,
  useListProvidersApiV1WorkspacesWorkspaceIdProvidersGet as useProviders,
  getListProvidersApiV1WorkspacesWorkspaceIdProvidersGetQueryKey as getProvidersQueryKey,
  useCreateProviderApiV1WorkspacesWorkspaceIdProvidersPost as useCreateProvider,
  useUpdateProviderApiV1ProvidersProviderIdPatch as useUpdateProvider,
  useTestProviderApiV1ProvidersProviderIdTestPost as useTestProvider,
  useProviderEnvironmentApiV1ProvidersEnvironmentGet as useProviderEnvironment,
  // meeting drafts / launch
  useCreateDraftApiV1ProjectsProjectIdMeetingDraftsPost as useCreateDraft,
  useValidateDraftApiV1MeetingDraftsDraftIdValidatePost as useValidateDraft,
  useLaunchDraftApiV1MeetingDraftsDraftIdLaunchPost as useLaunchDraft,
  // runs
  useListRunsApiV1ProjectsProjectIdRunsGet as useProjectRuns,
  getListRunsApiV1ProjectsProjectIdRunsGetQueryKey as getProjectRunsQueryKey,
  useGetRunApiV1RunsRunIdGet as useRun,
  getGetRunApiV1RunsRunIdGetQueryKey as getRunQueryKey,
  useGetRunTurnsApiV1RunsRunIdTurnsGet as useRunTurns,
  getGetRunTurnsApiV1RunsRunIdTurnsGetQueryKey as getRunTurnsQueryKey,
  useGetRunSummaryApiV1RunsRunIdSummaryGet as useRunSummary,
  getGetRunSummaryApiV1RunsRunIdSummaryGetQueryKey as getRunSummaryQueryKey,
  useGetRunEventsApiV1RunsRunIdEventsGet as useRunEvents,
  getGetRunEventsApiV1RunsRunIdEventsGetQueryKey as getRunEventsQueryKey,
  usePauseRunApiV1RunsRunIdPausePost as usePauseRun,
  useResumeRunApiV1RunsRunIdResumePost as useResumeRun,
  useCancelRunApiV1RunsRunIdCancelPost as useCancelRun,
  useRetryRunApiV1RunsRunIdRetryPost as useRetryRun,
  useAddInterventionApiV1RunsRunIdInterventionsPost as useAddIntervention,
  useListInterventionsApiV1RunsRunIdInterventionsGet as useInterventions,
  getListInterventionsApiV1RunsRunIdInterventionsGetQueryKey as getInterventionsQueryKey,
  // evidence
  useListEvidenceApiV1ProjectsProjectIdEvidenceGet as useProjectEvidence,
  getListEvidenceApiV1ProjectsProjectIdEvidenceGetQueryKey as getProjectEvidenceQueryKey,
  useUploadEvidenceApiV1ProjectsProjectIdEvidenceUploadPost as useUploadEvidence,
  useCreateEvidenceNoteApiV1ProjectsProjectIdEvidenceNotesPost as useCreateEvidenceNote,
  useGetEvidenceApiV1EvidenceSourceIdGet as useEvidenceSource,
  useListEvidenceChunksApiV1EvidenceSourceIdChunksGet as useEvidenceChunks,
  useArchiveEvidenceApiV1EvidenceSourceIdArchivePost as useArchiveEvidence,
  useSearchWorkspaceEvidenceApiV1WorkspacesWorkspaceIdEvidenceSearchPost as useSearchEvidence,
  usePmcSearchApiV1WorkspacesWorkspaceIdPmcSearchPost as usePmcSearch,
  usePmcImportApiV1ProjectsProjectIdEvidencePmcImportPost as usePmcImport,
  // provenance / reviews / exports
  useListRunCitationsApiV1RunsRunIdCitationsGet as useRunCitations,
  useGetRunManifestApiV1RunsRunIdManifestGet as useRunManifest,
  useListRunReviewsApiV1RunsRunIdReviewsGet as useRunReviews,
  getListRunReviewsApiV1RunsRunIdReviewsGetQueryKey as getRunReviewsQueryKey,
  useUpsertMyReviewApiV1RunsRunIdReviewsMinePut as useUpsertMyReview,
  useCreateExportApiV1RunsRunIdExportsPost as useCreateExport,
  useListExportsApiV1RunsRunIdExportsGet as useRunExports,
  getListExportsApiV1RunsRunIdExportsGetQueryKey as getRunExportsQueryKey,
  // comparisons
  useListComparisonsApiV1ProjectsProjectIdComparisonsGet as useProjectComparisons,
  getListComparisonsApiV1ProjectsProjectIdComparisonsGetQueryKey as getProjectComparisonsQueryKey,
  useCreateComparisonApiV1ProjectsProjectIdComparisonsPost as useCreateComparison,
  useGetComparisonApiV1ComparisonsComparisonIdGet as useComparison,
  getGetComparisonApiV1ComparisonsComparisonIdGetQueryKey as getComparisonQueryKey,
  useSubmitEvaluationApiV1ComparisonsComparisonIdEvaluationsPost as useSubmitEvaluation,
  useListEvaluationsApiV1ComparisonsComparisonIdEvaluationsGet as useComparisonEvaluations,
} from '@workspace/api-client-react';

/** Base URL prefix for hand-rolled requests (SSE, downloads). Includes no trailing slash. */
export function apiBase(): string {
  return `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/api`;
}

/** URL to download a completed export job (zip). */
export function exportDownloadUrl(jobId: string): string {
  return `${apiBase()}/v1/exports/${jobId}/download`;
}
