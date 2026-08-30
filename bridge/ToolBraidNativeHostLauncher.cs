using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class ToolBraidNativeHostLauncher
{
    private const string NodePath = @"__TOOLBRAID_NODE_PATH__";
    private const string HostScriptPath = @"__TOOLBRAID_HOST_SCRIPT_PATH__";
    private const string ConfigPath = @"__TOOLBRAID_CONFIG_PATH__";

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void Pump(Stream source, Stream destination, bool closeDestination)
    {
        try
        {
            var buffer = new byte[8192];
            int read;
            while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                destination.Write(buffer, 0, read);
                destination.Flush();
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            if (closeDestination)
            {
                try { destination.Close(); } catch { }
            }
        }
    }

    public static int Main()
    {
        var arguments = new StringBuilder();
        arguments.Append(Quote(HostScriptPath));
        arguments.Append(" --config ");
        arguments.Append(Quote(ConfigPath));
        var callerArguments = Environment.GetCommandLineArgs();
        for (var index = 1; index < callerArguments.Length; index++)
        {
            arguments.Append(' ');
            arguments.Append(Quote(callerArguments[index]));
        }

        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = NodePath,
                Arguments = arguments.ToString(),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        };
        process.Start();

        var inputThread = new Thread(() => Pump(Console.OpenStandardInput(), process.StandardInput.BaseStream, true));
        var outputThread = new Thread(() => Pump(process.StandardOutput.BaseStream, Console.OpenStandardOutput(), false));
        var errorThread = new Thread(() => Pump(process.StandardError.BaseStream, Console.OpenStandardError(), false));
        inputThread.IsBackground = true;
        outputThread.IsBackground = true;
        errorThread.IsBackground = true;
        inputThread.Start();
        outputThread.Start();
        errorThread.Start();
        process.WaitForExit();
        outputThread.Join(1000);
        errorThread.Join(1000);
        return process.ExitCode;
    }
}
