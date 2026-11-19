"""
LLM Client Wrapper
------------------
Connects to Google Gemini API using the official google-genai SDK.
Configures system instructions and equips the model with AGENT_TOOLS for function calling.
"""

import os
from typing import Any
from dotenv import load_dotenv
from google import genai
from google.genai import types
from rich.console import Console
from Harness._tools import AGENT_TOOLS

load_dotenv()

console=Console()

# System prompt Defining The Agents'e Behavoiur inside the Sandbox

SYSTEM_INSTRUCTION = """
You are a versatile, cloud-native autonomous AI assistant equipped with natural communication intelligence and isolated sandbox compute capabilities.
You handle three primary categories of user requests:
1. GENERAL MESSAGING & WRITING:
   - When asked to draft messages (emails, announcements, Slack updates, blogs, technical docs) or converse, respond directly with polished, professional prose.
   - Do NOT invoke code or sandbox tools when plain text is requested.
2. REAL-TIME DATA & UTILITIES:
   - When asked for weather forecasts or current conditions, invoke the `get_weather` tool with the requested location.
3. CLOUD SANDBOX SOFTWARE ENGINEERING:
   - When tasked with coding, fixing bugs, or running repositories inside your Linux sandbox (/workspace):
     a. Inspect files with `read_file` or check directories before editing.
     b. Write clean, surgical code with `create_file`.
     c. Run tests or commands with `run_command` (e.g., `pytest`, `python test.py`).
     d. Call `finish_task` when the fix is verified and passing.
"""

class LLMClient:
    """
    Manages multi-capability interactions with Google Gemini.
    """

    def __init__(self,model_name:str="gemini-3.1-flash-lite",api_key:str|None=None):
      self.api_key=api_key or os.getenv("GEMINI_API_KEY")

      if not self.api_key:
        console.print("[yellow]⚠ Warning: GEMINI_API_KEY is not set in environment or .env file.[/yellow]")

      # Initialize the official Google GenAI Client with v1beta for function calling support
      self.client = genai.Client(api_key=self.api_key, http_options={'api_version': 'v1beta'})
      self.model_name=model_name

      # Convert dictionary decalartion into google ai tools object

      tool_declarations=[
        types.FunctionDeclaration(**tool) for tool in AGENT_TOOLS
      ]
      self.tools=[types.Tool(function_declarations=tool_declarations)]
      # Configure model behavior

      self.config=types.GenerateContentConfig(
        tools=self.tools,
      )

    def generate_response(self,content:list[Any]|str)->Any:
        """
        Sends contents/history to Gemini.
        Returns response which can contain text, function_calls, or both.
        """

        if isinstance(content,str):
          content=[content]

        return self.client.models.generate_content(
          model=self.model_name,
          contents=content,
          config=self.config,
        )

    def create_chat_session(self):
        """
        Creates an ongoing multi-turn conversational chat session with memory.
        """
        return self.client.chats.create(
          model=self.model_name,
          config=self.config,
        )


if __name__ == "__main__":
    console.rule("[bold magenta]Testing Multi-Capability LLM Client")
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        console.print("[bold red]Please set GEMINI_API_KEY in Backend/.env to run this test.[/bold red]")
    else:
        llm = LLMClient()
        console.print(f"[green]✔ Model loaded: {llm.model_name}[/green]")
        console.print(f"[green]✔ Registered {len(AGENT_TOOLS)} tools (Coding + Weather).[/green]")
        # Test 1: Message Generation (Should return pure text, NO tool call)
        console.rule("[cyan]Test 1: Message Generation Prompt")
        msg_prompt = "Draft a short, professional Slack announcement telling the engineering team that our new cloud sandbox backend is live."
        console.print(f"[dim]User: {msg_prompt}[/dim]\n")
        res1 = llm.generate_response(msg_prompt)
        console.print(f"[bold green]AI Generated Message:[/bold green]\n{res1.text}\n")
        # Test 2: Weather Request (Should emit 'get_weather' tool call)
        console.rule("[cyan]Test 2: Weather Tool Request")
        weather_prompt = "What is the weather in Tokyo right now?"
        console.print(f"[dim]User: {weather_prompt}[/dim]\n")
        res2 = llm.generate_response(weather_prompt)
        if res2.function_calls:
            for call in res2.function_calls:
                console.print(f"[bold yellow]✔ Model invoked Tool Call:[/bold yellow] [bold cyan]{call.name}[/bold cyan]")
                console.print(f"Arguments: {call.args}")
        else:
            console.print(f"Text: {res2.text}")