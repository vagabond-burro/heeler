# Ask an AI about Heeler

If you already use Claude, ChatGPT or Gemini, you can ask it how to do something in Heeler and have it answer from this user guide instead of from what it knows about other photo editors. The Heeler help kit gives it the guide and a short set of instructions: answer from the guide, name the chapter, suggest the most direct tool, keep it short, and say so when the guide does not cover something.

## The help kit

The kit is three files, rebuilt from this guide with every Heeler release:

- [heeler-help-kit.zip](https://github.com/vagabond-burro/heeler/releases/latest/download/heeler-help-kit.zip): the guide as a skill for Claude. Upload it as it is; do not unzip it.
- [heeler-user-guide.md](https://github.com/vagabond-burro/heeler/releases/latest/download/heeler-user-guide.md): the whole guide as one file, for ChatGPT and Gemini.
- [heeler-help-instructions.txt](https://github.com/vagabond-burro/heeler/releases/latest/download/heeler-help-instructions.txt): the instructions, to paste into ChatGPT or Gemini.

The links always give the kit for the latest release. After you update Heeler, download the kit again and replace the copy you gave your assistant, so its answers describe the version you are using.

## Claude

Custom skills work on every Claude plan, Free included.

1. In Claude, open **Settings > Capabilities** and turn on **Code execution and file creation**. On a Team or Enterprise plan, an administrator enables skills for the organization.
2. Open **Customize > Skills**.
3. Click **+**, choose **Create skill**, then **Upload a skill**.
4. Choose **heeler-help-kit.zip**.
5. Make sure the **heeler-help** skill is switched on in the list.

Then ask in any chat, for example "How do I darken a blue sky in Heeler?". Claude uses the skill when a question is about Heeler. To update it after a Heeler release, remove the old heeler-help skill and upload the new ZIP the same way.

## ChatGPT

Use a Project, which keeps the guide and the instructions together for every chat inside it.

1. In ChatGPT's sidebar, create a new project and name it Heeler.
2. Add **heeler-user-guide.md** to the project's files.
3. Open the project's instructions and paste the whole of **heeler-help-instructions.txt**.
4. Start your Heeler chats inside that project.

To update it, replace the project's heeler-user-guide.md with the new one and paste the new instructions over the old.

## Gemini

Use a Gem, a saved version of Gemini with its own instructions and files.

1. At gemini.google.com, open the sidebar and click **Gems**, then **New Gem**.
2. Name it Heeler and paste the whole of **heeler-help-instructions.txt** into its instructions.
3. Under **Knowledge**, click **Add files** and upload **heeler-user-guide.md**.
4. Click **Save**. Open the Gem from **My Gems** in the Gems list whenever you have a Heeler question.

To update it, edit the Gem, remove the old guide file, add the new one and paste the new instructions.

## Privacy and accuracy

Claude, ChatGPT and Gemini are third-party services you choose. What you type there, and the files you give them, are handled under that service's own terms and privacy policy, not Heeler's. Heeler sends nothing to them: the kit is files you download and hand over yourself.

An assistant can still get an answer wrong, even with the guide in front of it. Check its steps against the chapter it names, and if a control it describes is not where it says, the guide is the authority.
