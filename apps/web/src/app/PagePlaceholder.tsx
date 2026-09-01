import { EmptyState } from "../components/ui/EmptyState";

/**
 * Stands in for a screen the router already routes to but whose task has not
 * landed yet. Every use of this is deleted by the task named in `task`.
 *
 * The routes exist now because the shell is what Task 18 delivers: a sidebar
 * whose links go nowhere would not have verified anything.
 */
export function PagePlaceholder({
  title,
  task,
}: {
  title: string;
  task: string;
}) {
  return (
    <>
      <h1 className="text-2xl font-semibold text-text">{title}</h1>
      <EmptyState
        title="Not built yet"
        description={`This screen arrives in ${task}.`}
      />
    </>
  );
}
