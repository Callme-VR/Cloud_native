"""
Autonomous Agent Execution Loop (ReAct State Machine)
-----------------------------------------------------
Drives the autonomous Observe -> Reason -> Act -> Evaluate cycle:
  1. Accepts user task/prompt.
  2. Spawns isolated sandbox.
  3. LLM reasons and decides tool actions (read_file, create_file, run_command).
  4. Dispatches tool execution in Docker sandbox.
  5. Feeds tool results back into LLM context.
  6. Repeats until tests pass and the agent calls `finish_task`.
"""

from typing import Any, Callable
from google.genai import types
from rich.console import Console
from rich.panel import Panel

from Sandbox import create_sandbox, destroy_sandbox, get_git_diff, create_file
from Harness._LLM_client import LLMClient
from Harness._execute_tools import execute_tool

console = Console()


def run_agent_loop(
    task_prompt: str,
    max_iterations: int = 15,
    model_name: str = "gemini-2.5-flash",
    interactive_destroy: bool = True,
    event_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """
    Executes the full autonomous ReAct agent loop inside an isolated Docker sandbox.

    Args:
        task_prompt: Description of the task or bug to solve.
        max_iterations: Safety ceiling to prevent runaway infinite loops.
        model_name: Gemini model to use.
        interactive_destroy: Whether to prompt (y/n) before destroying the sandbox.
        event_callback: Optional callable for streaming live events (WebSockets).

    Returns:
        dict[str, Any]: Final report containing status, summary, steps taken, and git diff.
    """
    console.rule("[bold magenta]Autonomous Agent Execution Loop Started")
    console.print(Panel(task_prompt, title="[bold cyan]Task Prompt[/bold cyan]", border_style="cyan"))

    # 1. Spawn the isolated sandbox container
    container, vol_name = create_sandbox()
    llm = LLMClient(model_name=model_name)
    chat = llm.create_chat_session()

    execution_history: list[dict[str, Any]] = []
    final_summary: str = "Task completed without explicit summary."
    task_completed = False

    try:
        # 2. Kick off the conversation with the user prompt
        response = chat.send_message(task_prompt)

        for step in range(1, max_iterations + 1):
            console.rule(f"[bold blue]Step {step}/{max_iterations}")

            # Print agent's reasoning text if returned
            thought_text = response.text.strip() if response.text else ""
            if thought_text:
                console.print(Panel(
                    thought_text,
                    title=f"[bold green]Agent Reasoning (Step {step})[/bold green]",
                    border_style="green"
                ))
                if event_callback:
                    event_callback({
                        "event": "thought",
                        "step": step,
                        "content": thought_text
                    })

            # 3. Check if the model invoked any tools
            if not response.function_calls:
                console.print("[bold yellow]Agent concluded without requesting further tools.[/bold yellow]")
                final_summary = response.text or "Direct answer generated."
                task_completed = True
                break

            response_parts = []
            for call in response.function_calls:
                tool_name = call.name
                tool_args = dict(call.args) if call.args else {}

                console.print(f"[bold yellow]→ Agent Call:[/bold yellow] [bold cyan]{tool_name}[/bold cyan]({tool_args})")

                # If the agent signals completion, terminate the loop
                if tool_name == "finish_task":
                    final_summary = tool_args.get("summary", "Task resolved.")
                    task_completed = True
                    console.print(Panel(
                        f"[bold green]✔ {final_summary}[/bold green]",
                        title="[bold green]Task Finished[/bold green]",
                        border_style="green"
                    ))
                    break

                # Execute tool inside the Docker sandbox
                tool_result = execute_tool(container, tool_name, tool_args)

                # Record execution step
                step_data = {
                    "step": step,
                    "tool": tool_name,
                    "args": tool_args,
                    "result": tool_result
                }
                execution_history.append(step_data)

                if event_callback:
                    event_callback({
                        "event": "tool_execution",
                        **step_data
                    })

                # Format response back to Gemini function calling protocol
                resp_part = types.Part.from_function_response(
                    name=tool_name,
                    response={"result": tool_result}
                )
                response_parts.append(resp_part)

            if task_completed:
                break

            # 4. Feed tool results back into Gemini chat session
            with console.status("[bold cyan]Agent is thinking & analyzing tool results..."):
                response = chat.send_message(response_parts)

        # 5. Extract unified git patch of changes
        git_diff = get_git_diff(container)

        result_report = {
            "status": "completed" if task_completed else "max_iterations_reached",
            "summary": final_summary,
            "total_steps": len(execution_history),
            "diff": git_diff,
            "history": execution_history
        }

        console.rule("[bold green]Agent Execution Finished")
        console.print(f"[bold]Status:[/bold] {result_report['status']}")
        console.print(f"[bold]Total Tool Invocations:[/bold] {result_report['total_steps']}")
        if git_diff:
            console.print(Panel(git_diff, title="[bold yellow]Generated Git Diff[/bold yellow]", border_style="yellow"))

        return result_report

    finally:
        if interactive_destroy:
            confirm = console.input("\n[bold yellow]Destroy sandbox now? (y/n): [/bold yellow]").strip().lower()
            if confirm in ("y", "yes", ""):
                destroy_sandbox(container, vol_name)
            else:
                console.print(f"[cyan]Sandbox {container.name} left alive for inspection.[/cyan]")
        else:
            destroy_sandbox(container, vol_name)


if __name__ == "__main__":
    # Self-contained Autonomous Bug-Fixing Test
    console.rule("[bold magenta]Autonomous Bug-Fix Demonstration")

    # We ask the agent to fix a real Python bug inside the sandbox
    test_task = (
        "We have a math module at 'src/calculator.py'. "
        "Create the initial file with a divide function that currently crashes on zero division: "
        "'def divide(a, b): return a / b'. "
        "Then fix it so divide(a, 0) safely returns None instead of raising ZeroDivisionError. "
        "Test your fix by running python in the terminal and verifying divide(10, 0) is None, "
        "then call finish_task."
    )

    run_agent_loop(test_task, max_iterations=6, interactive_destroy=True)
