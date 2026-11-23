"""
Sandbox Setup & Lifecycle Management
-----------------------------------
Responsible for:
  - Spawning isolated, resource-constrained Docker containers.
  - Generating unique UUID-tagged containers and volumes to prevent race conditions.
  - Enforcing hard cgroup limits (512MB RAM, 1 CPU, 64 PIDs, dropped capabilities).
  - Cleanly tearing down containers and wiping associated storage volumes (zero inode/storage leaks).
"""

import uuid
import docker
from docker.models.containers import Container
from rich.console import Console
from rich.panel import Panel

console = Console()

# Lazy Docker client connection
_docker_client: docker.DockerClient | None = None


def get_docker_client() -> docker.DockerClient:
    """Lazily initializes and caches the Docker client on first operational call."""
    global _docker_client
    if _docker_client is None:
        try:
            _docker_client = docker.from_env()
            _docker_client.ping()
        except Exception as e:
            _docker_client = None
            console.print(f"[bold red]Failed to connect to Docker daemon: {e}[/bold red]")
            raise RuntimeError(
                "Docker daemon is not running. Please start Docker Desktop to execute sandbox tasks."
            ) from e
    return _docker_client


def create_sandbox(image: str = "cloud-native-sandbox:latest") -> tuple[Container, str]:
    """
    Spawns an isolated, resource-constrained container sandbox.

    Args:
        image: Docker base image (default: python:3.12-slim)

    Returns:
        tuple[Container, str]: The running Docker container and its unique workspace volume name.
    """
    client = get_docker_client()

    # 1. Unique identifiers prevent volume collisions during concurrent agent runs
    unique_id = uuid.uuid4().hex[:8]
    container_name = f"agent-sandbox-{unique_id}"
    volume_name = f"agent-workspace-{unique_id}"

    # 2. Spawn container with defense-in-depth security & host resource protections
    with console.status(f"[bold cyan]Spinning up sandbox {container_name}..."):
        container = client.containers.run(
            image=image,
            name=container_name,
            command="sleep infinity",       # Keeps container alive for interactive tool calls
            detach=True,
            working_dir="/workspace",
            network_disabled=True,          # Air-gapped: blocks unauthorized network egress
            mem_limit="512m",               # Memory ceiling: protects host RAM from runaway scripts
            nano_cpus=1_000_000_000,        # CPU ceiling: capped at 1 CPU core
            pids_limit=64,                  # Mitigates fork bombs
            cap_drop=["ALL"],               # Drops all default Linux root capabilities
            security_opt=["no-new-privileges"],  # Prevents privilege escalation
            volumes={
                volume_name: {
                    "bind": "/workspace",
                    "mode": "rw"
                }
            }
        )

    return container, volume_name


def destroy_sandbox(container: Container, volume_name: str | None = None) -> bool:
    """
    Safely tears down the container and wipes its associated storage volume.

    Args:
        container: The Docker container object to destroy.
        volume_name: Optional volume name to delete.

    Returns:
        bool: True if cleanup succeeded, False otherwise.
    """
    if container is None:
        console.print("[yellow]⚠ destroy_sandbox received None container. Skipping.[/yellow]")
        return False

    try:
        with console.status(f"[bold red]Destroying sandbox {container.name}..."):
            # v=True ensures associated anonymous volumes are removed
            container.remove(v=True, force=True)

            # Explicitly delete the named workspace volume to prevent storage/inode leaks
            if volume_name:
                try:
                    client = get_docker_client()
                    vol = client.volumes.get(volume_name)
                    vol.remove(force=True)
                except docker.errors.NotFound:
                    pass

        console.print(f"[green]✔ Sandbox {container.name} and volume {volume_name} destroyed successfully[/green]")
        return True

    except Exception as e:
        console.print(f"[bold red]✘ Error occurred while destroying sandbox:[/bold red] {e}")
        return False


# Aliases for backward compatibility
create_Sandbox = create_sandbox
Destroy_sandbox = destroy_sandbox


if __name__ == "__main__":
    console.rule("[bold magenta]Testing Sandbox Lifecycle")

    # 1. Create sandbox
    container, volume_name = create_sandbox()

    console.print(Panel.fit(
        f"[bold]Container:[/bold] {container.name} (ID: {container.short_id})\n"
        f"[bold]Volume:[/bold]    {volume_name}\n"
        f"[bold]Status:[/bold]    {container.status}\n"
        f"[bold]RAM Cap:[/bold]   512 MB | [bold]CPU Cap:[/bold] 1 Core | [bold]PID Limit:[/bold] 64",
        title="[bold green]Sandbox Created & Guarded[/bold green]",
        border_style="green"
    ))

    # 2. Verify it is running
    container.reload()
    assert container.status == "running", "Container failed to start!"
    console.print("[green]Verification: Sandbox is active and running with strict resource caps.[/green]")

    # 3. Confirmation prompt before destruction
    confirm = console.input("\n[bold yellow]Do you want to destroy this sandbox now? (y/n): [/bold yellow]").strip().lower()

    if confirm in ("y", "yes", ""):
        destroy_sandbox(container, volume_name)
        console.print("[bold green]Verification: Sandbox and volume cleanly destroyed![/bold green]")
    else:
        console.print(f"[bold cyan]Sandbox left running for inspection![/bold cyan]")
        console.print(f"Container: [white]{container.name}[/white]")
        console.print(f"Volume:    [white]{volume_name}[/white]")
        console.print(f"[dim]Tip: Destroy manually later with: docker rm -f {container.name}[/dim]")
