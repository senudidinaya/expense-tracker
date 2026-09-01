import { useNavigate } from "react-router";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

export function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6">
      <EmptyState
        title="Page not found"
        description="That URL does not match any screen in this app."
        action={
          <Button variant="primary" onClick={() => void navigate("/")}>
            Go to dashboard
          </Button>
        }
      />
    </div>
  );
}
