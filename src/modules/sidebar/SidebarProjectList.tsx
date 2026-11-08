import { useEffect } from 'react';
import { Virtuoso } from 'react-virtuoso';

import type { Project, SidebarProjectListProps } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectsState from '@/modules/sidebar/SidebarProjectsState';


/** Rendered by SidebarContent to list the filtered projects, delegating each row to SidebarProjectItem. */
export default function SidebarProjectList({
  scrollParent,
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  isProjectExpanded,
  activeRename,
  initialSessionsLoaded,
  currentTime,

  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  isProjectStarred,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onArchiveSession,
  onDeleteSession,
  onForkSession,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  regeneratingTitleSessionIds,
  onRegenerateSessionTitle,
  onToggleSessionPin,
  sessionSelection,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectListProps & { scrollParent?: HTMLElement | null }) {
  const pageTitle = getPageTitle(selectedProject, selectedSession);
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  const renderProject = (project: Project) => {
              // Both renames are resolved here rather than inside the row, so
              // every other row is handed the same scalars on each keystroke and
              // its memo boundary holds.
              const renamingProject =
                activeRename?.target === 'project' && activeRename.id === project.projectId
                  ? activeRename
                  : null;
              const renamingSession =
                activeRename?.target === 'session' && activeRename.projectId === project.projectId
                  ? activeRename
                  : null;
              // Resolved here for the same reason as the renames: only the
              // project in selection mode sees a set, every other row keeps
              // being handed the same `null` and its memo holds.
              const selectedSessionIds =
                sessionSelection?.projectId === project.projectId ? sessionSelection.sessionIds : null;

              // React key + per-project state lookups all use the DB `projectId`
              // so they remain stable across renames and session changes.
              return (
              <SidebarProjectItem
                key={project.projectId}
                project={project}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                isExpanded={isProjectExpanded(project.projectId)}
                isDeleting={deletingProjects.has(project.projectId)}
                isStarred={isProjectStarred(project.projectId)}
                isEditing={renamingProject !== null}
                renameDraft={renamingProject?.draft ?? ''}
                sessions={getProjectSessions(project)}
                initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
                isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
                currentTime={currentTime}
                sessionRenameId={renamingSession?.id ?? null}
                sessionRenameDraft={renamingSession?.draft ?? ''}
                tasksEnabled={tasksEnabled}
                mcpServerStatus={mcpServerStatus}
                onRenameDraftChange={onRenameDraftChange}
                onToggleProject={onToggleProject}
                onProjectSelect={onProjectSelect}
                onToggleStarProject={onToggleStarProject}
                onStartEditingProject={onStartEditingProject}
                onCancelEditingProject={onCancelEditingProject}
                onSaveProjectName={onSaveProjectName}
                onDeleteProject={onDeleteProject}
                onSessionSelect={onSessionSelect}
                onArchiveSession={onArchiveSession}
                onDeleteSession={onDeleteSession}
                onForkSession={onForkSession}
                onLoadMoreSessions={onLoadMoreSessions}
                activeSessions={activeSessions}
                backgroundSessionIds={backgroundSessionIds}
                attentionSessionIds={attentionSessionIds}
                onNewSession={onNewSession}
                onStartEditingSession={onStartEditingSession}
                onCancelEditingSession={onCancelEditingSession}
                onSaveEditingSession={onSaveEditingSession}
                regeneratingTitleSessionIds={regeneratingTitleSessionIds}
                onRegenerateSessionTitle={onRegenerateSessionTitle}
                onToggleSessionPin={onToggleSessionPin}
                selectedSessionIds={selectedSessionIds}
                onSetSessionSelection={onSetSessionSelection}
                onToggleSessionSelected={onToggleSessionSelected}
                onCancelSessionSelection={onCancelSessionSelection}
                onDeleteSelectedSessions={onDeleteSelectedSessions}
                t={t}
              />
            );
  };

  // GOLDJAXE fork (реестр §21): сотни закрытых проектов не должны создавать
  // тысячи DOM-узлов при каждом возврате во вкладку. Высоты раскрытых групп
  // измеряет Virtuoso; данные, порядок и состояние сессий остаются у контроллера.
  const virtualized = filteredProjects.length > 60 && scrollParent !== undefined;
  return (
    <div className="pb-safe-area-inset-bottom md:space-y-1">
      {!showProjects ? state : virtualized ? (
        scrollParent && (
          <Virtuoso
            customScrollParent={scrollParent}
            data={filteredProjects}
            computeItemKey={(_index, project) => project.projectId}
            increaseViewportBy={200}
            itemContent={(_index, project) => (
              <div className="md:pb-1">{renderProject(project)}</div>
            )}
          />
        )
      ) : filteredProjects.map(renderProject)}
    </div>
  );
}
