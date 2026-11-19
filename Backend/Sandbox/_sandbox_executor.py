"""
Sandbox Command & File Execution Engine
---------------------------------------
Responsible for:
  - Executing commands inside the running sandbox container.
  - Demuxing stdout and stderr cleanly to avoid stream corruption.
  - Streaming real-time command output line-by-line for live terminal views.
  - Safe file creation using Base64 encoding (avoids shell escaping/newline corruption).
  - Safe file reading and git diff extraction.
"""

import base64
import shlex
from typing import Generator
from docker.models.containers import Container
from retry import retry
from rich.console import Console

console = Console()


def run_command(container: Container, cmd: str) -> tuple[int, str, str]:
    """
    Executes a shell command inside the sandbox container.

    Args:
        container: The active Docker container.
        cmd: The shell command string to execute.

    Returns:
        tuple[int, str, str]: (exit_code, stdout, stderr)
    """
    console.print(f"[cyan]→ running:[/cyan] [dim]{cmd}[/dim]")

    with console.status("[bold cyan]Executing command in sandbox..."):
        exec_result = container.exec_run(
            cmd=f"sh -c {shlex.quote(cmd)}",
            demux=True,
            workdir="/workspace"
        )

    exit_code = exec_result.exit_code

    # Safe unpacking in case exec_result.output is None
    if exec_result.output is not None:
        stdout_bytes, stderr_bytes = exec_result.output
    else:
        stdout_bytes, stderr_bytes = b"", b""

    stdout_str = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
    stderr_str = stderr_bytes.decode("utf-8", errors="replace") if stderr_bytes else ""

    if exit_code == 0:
        console.print(f"[green]✔ exit code {exit_code}[/green]")
    else:
        console.print(f"[red]✘ exit code {exit_code}[/red]")

    if stdout_str:
        console.print(f"[white]{stdout_str}[/white]", end="")
    if stderr_str:
        console.print(f"[red]{stderr_str}[/red]", end="")

    return exit_code, stdout_str, stderr_str


def run_command_stream(container: Container, cmd: str) -> Generator[str, None, None]:
    """
    Executes a command and yields stdout/stderr chunks in real-time.
    Used for streaming terminal output over WebSockets to the React control plane.

    Args:
        container: The active Docker container.
        cmd: The shell command to execute.

    Yields:
        str: Decoded output chunks as they arrive from the container process.
    """
    console.print(f"[cyan]→ streaming:[/cyan] [dim]{cmd}[/dim]")

    exec_instances = container.client.api.exec_create(
        container=container.id,
        cmd=f"sh -c {shlex.quote(cmd)}",
        workdir="/workspace"
    )

    output_stream = container.client.api.exec_start(
        exec_id=exec_instances["Id"],
        stream=True
    )

    for chunk in output_stream:
        decoded = chunk.decode("utf-8", errors="replace")
        yield decoded


@retry(tries=3, delay=1)
def create_file(container: Container, path: str, content: str) -> tuple[int, str, str]:
    """
    Creates or overwrites a file inside the container using Base64 encoding.
    Base64 guarantees safe transfer without shell escaping, quote collisions, or newline issues.

    Args:
        container: The active Docker container.
        path: Relative or absolute path inside the container workspace.
        content: Text content to write into the file.

    Returns:
        tuple[int, str, str]: (exit_code, stdout, stderr)
    """
    console.print(f"[cyan]→ writing file:[/cyan] {path}")

    encoded_content = base64.b64encode(content.encode("utf-8")).decode("utf-8")
    quoted_path = shlex.quote(path)

    # 1. Create parent directory if it does not exist (mkdir -p)
    # 2. Decode Base64 payload and redirect into target path
    command = (
        f'mkdir -p "$(dirname {quoted_path})" && '
        f'printf %s {shlex.quote(encoded_content)} | base64 -d > {quoted_path}'
    )

    exit_code, stdout_str, stderr_str = run_command(container, command)

    if exit_code == 0:
        console.print(f"[green]✔ wrote {path}[/green]")
    else:
        console.print(f"[red]✘ failed to write {path}[/red]")

    return exit_code, stdout_str, stderr_str


def read_file(container: Container, path: str) -> str:
    """
    Reads the content of a file from inside the sandbox workspace.

    Args:
        container: The active Docker container.
        path: Path of the file to read.

    Returns:
        str: The content of the file.

    Raises:
        FileNotFoundError: If the file does not exist or cat returns non-zero.
    """
    console.print(f"[cyan]→ reading file:[/cyan] {path}")

    quoted_path = shlex.quote(path)
    exit_code, stdout_str, stderr_str = run_command(container, f"cat {quoted_path}")

    if exit_code != 0:
        console.print(f"[red]✘ failed to read {path}[/red]")
        raise FileNotFoundError(f"Failed to read file '{path}': {stderr_str.strip()}")

    console.print(f"[green]✔ read {path}[/green]")
    return stdout_str


def get_git_diff(container: Container) -> str:
    """
    Extracts the git diff / patch of all modifications made inside the workspace.

    Args:
        container: The active Docker container.

    Returns:
        str: Unified git diff output.
    """
    console.print("[cyan]→ getting git diff[/cyan]")
      # Check if git repo exists; if not, initialize one to track changes
    check_code, _, _ = run_command(container, "git status")
    if check_code != 0:
        run_command(container, "git init && git add -A && git commit -m 'initial commit'")
        return ""
    exit_code, stdout_str, _ = run_command(container, "git diff")
    return stdout_str if exit_code == 0 else ""


# Alias for backward compatibility
Run_command = run_command


if __name__ == "__main__":
    # Support both direct script execution and package imports
    try:
        from _sandbox_setup import create_sandbox, destroy_sandbox
    except ImportError:
        from Sandbox._sandbox_setup import create_sandbox, destroy_sandbox

    console.rule("[bold magenta]Testing Sandbox Executor Engine")
    container, vol_name = create_sandbox()

    try:
        # 1. Test File Creation inside the container
        test_code = (
            "def calculate(a, b):\n"
            "    return (a * b) + 50\n\n"
            "if __name__ == '__main__':\n"
            "    print(f'Calculation Success: {calculate(10, 5)}')\n"
        )
        file_path = "src/math_test.py"
        exit_code, _, stderr_str = create_file(container, file_path, test_code)
        assert exit_code == 0, f"create_file failed: {stderr_str}"

        # 2. Test File Reading
        read_content = read_file(container, file_path)
        assert "Calculation Success" in read_content, "read_file content mismatch!"
        console.print(f"[dim]File content verified ({len(read_content)} bytes).[/dim]")

        # 3. Test Running the Python script inside the container
        console.print("\n[bold cyan]Executing Python script inside container...[/bold cyan]")
        exit_code, stdout_str, stderr_str = run_command(container, "python src/math_test.py")
        assert exit_code == 0 and "100" in stdout_str, "Script execution verification failed!"
        console.print("[bold green]✔ In-container Python execution succeeded (returned 100)![/bold green]")

        # 4. Test Real-time Streaming
        console.rule("[bold magenta]Testing Real-Time Output Stream")
        stream_cmd = "python -c 'import time; [print(f\"Stream tick {i+1}/3\", flush=True) or time.sleep(0.3) for i in range(3)]'"
        for chunk in run_command_stream(container, stream_cmd):
            console.print(f"[yellow]--> {chunk.strip()}[/yellow]")

        console.print("\n[bold green]All Executor tests PASSED successfully![/bold green]")

    finally:
        # Ask for confirmation before destroying so the user can inspect in Docker Desktop if desired
        confirm = console.input("\n[bold yellow]Do you want to destroy this sandbox now? (y/n): [/bold yellow]").strip().lower()

        if confirm in ("y", "yes", ""):
            destroy_sandbox(container, vol_name)
            console.print("[green]Sandbox cleaned up successfully.[/green]")
        else:
            console.print(f"[bold cyan]Sandbox left running for inspection![/bold cyan]")
            console.print(f"Container: [white]{container.name}[/white]")
            console.print(f"Volume:    [white]{vol_name}[/white]")
            console.print(f"[dim]Tip: Destroy manually later with: docker rm -f {container.name}[/dim]")
