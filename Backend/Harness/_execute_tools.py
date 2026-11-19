"""
Tool Execution Dispatcher
-------------------------
Routes incoming LLM tool calls to the Sandbox execution engine.
Catches errors and formats responses back to the LLM context.
"""

from typing import Any
from docker.models.containers import Container
from rich.console import Console

from Sandbox import (
    create_file,
    read_file,
    run_command,
    get_git_diff,
    create_sandbox,
    destroy_sandbox,
)

console = Console()


def execute_tool(container: Container, tool_name: str, tools_args: dict[str, Any]) -> dict[str, Any]:
    """
    Executes a requested tool call inside the given container sandbox.

    Args:
        container: Active Docker sandbox container.
        tool_name: The name of the tool called by the LLM.
        tools_args: Dictionary of arguments supplied by the LLM.

    Returns:
        dict[str, Any]: Structured result dictionary fed back into the LLM context.
    """
    console.print(f"[bold yellow]⚡ Dispatching Tool:[/bold yellow] [bold cyan]{tool_name}[/bold cyan]")

    try:
        if tool_name == "create_file":
            path = tools_args.get("path", "")
            content = tools_args.get("content", "")
            if not path:
                return {"status": "error", "error": "Missing required parameter: 'path'"}
            exit_code, stdout_str, stderr_str = create_file(container, path, content)
            if exit_code == 0:
                return {"status": "success", "message": f"File '{path}' written successfully."}
            else:
                return {"status": "error", "error": f"Failed to write '{path}': {stderr_str}"}

        elif tool_name == "read_file":
            path = tools_args.get("path", "")
            if not path:
                return {"status": "error", "error": "Missing required parameter: 'path'"}
            content = read_file(container, path)
            return {"status": "success", "content": content}

        elif tool_name == "run_command":
            # Supports both 'command' and 'cmd' keys for resilience
            cmd = tools_args.get("command") or tools_args.get("cmd", "")
            if not cmd:
                return {"status": "error", "error": "Missing required parameter: 'command'"}
            exit_code, stdout_str, stderr_str = run_command(container, cmd)
            if exit_code == 0:
                return {
                    "status": "success",
                    "stdout": stdout_str,
                    "stderr": stderr_str,
                    "exit_code": exit_code
                }
            else:
                return {
                    "status": "error",
                    "error": stderr_str,
                    "stdout": stdout_str,
                    "exit_code": exit_code
                }

        elif tool_name == "get_git_diff":
            diff = get_git_diff(container)
            return {"status": "success", "diff": diff or "No changes detected."}

        elif tool_name == "get_weather":
            loc = tools_args.get("location", "Unknown Location")
            return {
                "status": "success",
                "weather": f"Current weather in {loc}: 22°C (72°F), Clear Skies, Wind 8 km/h, Humidity 45%."
            }

        elif tool_name == "finish_task":
            summary = tools_args.get("summary", "Task completed.")
            return {"status": "completed", "summary": summary}

        else:
            return {"status": "error", "error": f"Unknown tool: '{tool_name}'"}

    except Exception as e:
        console.print(f"[bold red]Tool execution exception:[/bold red] {e}")
        return {"status": "error", "error": str(e)}


if __name__ == "__main__":
    console.rule("[bold magenta]Testing Tool Dispatcher")
    container, vol_name = create_sandbox()

    try:
        # 1. Test dispatching 'create_file'
        res1 = execute_tool(container, "create_file", {
            "path": "hello.py",
            "content": "print('Tool Dispatcher Works!')"
        })
        console.print(f"create_file response: {res1}")
        assert res1["status"] == "success"

        # 2. Test dispatching 'read_file'
        res2 = execute_tool(container, "read_file", {"path": "hello.py"})
        console.print(f"read_file response: {res2}")
        assert "Tool Dispatcher Works!" in res2["content"]

        # 3. Test dispatching 'run_command'
        res3 = execute_tool(container, "run_command", {"command": "python hello.py"})
        console.print(f"run_command response: {res3}")
        assert res3["exit_code"] == 0 and "Tool Dispatcher Works!" in res3["stdout"]

        console.print("\n[bold green]✔ All Tool Dispatcher tests PASSED![/bold green]")

    finally:
        destroy_sandbox(container, vol_name)
