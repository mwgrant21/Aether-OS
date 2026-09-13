using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

// Harmless native-console fixture. No model SDK, networking or MCP.
// Commands arrive through a private test file; stdin is read only after the
// explicit fixture-only record command.
class ConnectedClientFixture {
  const string InputSentinel = "AETHER_INPUT_RECORDING_COMPLETE_6C";
  static volatile bool recording;
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll")] static extern bool SetConsoleMode(IntPtr h, uint mode);
  [DllImport("kernel32.dll")] static extern bool WriteFile(IntPtr h, byte[] bytes, uint length, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool ReadConsoleW(
    IntPtr h, [Out] char[] chars, uint length, out uint read, IntPtr inputControl);
  static void Paint(IntPtr handle, string text) {
    var bytes = Encoding.UTF8.GetBytes(text); uint written;
    if (!WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero) || written != bytes.Length)
      throw new IOException("Native fixture paint failed");
  }
  static string Hex(byte[] bytes) {
    var builder = new StringBuilder(bytes.Length * 2);
    foreach (var value in bytes) builder.Append(value.ToString("x2"));
    return builder.ToString();
  }
  static void RecordInput(IntPtr output, string root) {
    if (recording) return;
    recording = true;
    var thread = new Thread(() => {
      try {
        var inputHandle = GetStdHandle(-10); uint inputMode;
        // Disable processed, line and echo input only for this explicit recorder.
        // This avoids the Windows cooked-line cap and captures xterm/ConPTY
        // Unicode code units as they arrive; existing fixture behavior never
        // enters this mode.
        if (!GetConsoleMode(inputHandle, out inputMode)) throw new IOException("Could not read native fixture input mode");
        if (!SetConsoleMode(inputHandle, inputMode & ~7u)) throw new IOException("Could not set native fixture raw input mode");
        Paint(output, "\r\nAETHER_INPUT_RECORDING_READY\r\n");
        var received = new StringBuilder();
        var buffer = new char[4096];
        while (true) {
          uint count;
          if (!ReadConsoleW(inputHandle, buffer, (uint)buffer.Length, out count, IntPtr.Zero) || count == 0)
            throw new EndOfStreamException("Native fixture stdin closed");
          received.Append(buffer, 0, (int)count);
          var text = received.ToString();
          var offset = text.IndexOf(InputSentinel, StringComparison.Ordinal);
          if (offset < 0) continue;
          var payload = Encoding.UTF8.GetBytes(text.Substring(0, offset));
          File.WriteAllBytes(Path.Combine(root, "input-received.bin"), payload);
          byte[] hash;
          using (var sha = SHA256.Create()) hash = sha.ComputeHash(payload);
          File.WriteAllText(Path.Combine(root, "input-receipt.json"),
            "{\"bytes\":" + payload.Length + ",\"sha256\":\"" + Hex(hash) + "\"}");
          Paint(output, "\r\nAETHER_INPUT_RECORDING_COMPLETE\r\n");
          return;
        }
      } finally { recording = false; }
    });
    thread.IsBackground = true;
    thread.Start();
  }
  static void Main(string[] args) {
    if (args.Length == 1 && args[0] == "--version") {
      Console.WriteLine("2.1.269 (Aether harmless native fixture)"); return;
    }
    var root = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    var h = GetStdHandle(-11); uint mode;
    if (GetConsoleMode(h, out mode)) SetConsoleMode(h, mode | 4);
    Console.OutputEncoding = new UTF8Encoding(false);
    File.WriteAllText(Path.Combine(root, "client-pid"), System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
    var prompt = File.ReadAllText(Path.Combine(root, "prompt.txt"));
    // Synthetic supported frame: preserve every semantic row/cursor offset,
    // omit only the full-width decorative rule that requires implicit wrap in
    // ConPTY's canonical repaint. Never modify observed native output.
    var supportedPrompt = prompt.Replace(new string('─', 100), "");
    var last = "";
    while (true) {
      string command = "";
      try { command = File.ReadAllText(Path.Combine(root, "control")); } catch (IOException) { }
      if (command != last) {
        last = command;
        // The captured client leaves its cursor hidden mid-frame. Complete the
        // fixture frame so ConPTY restores the actual cursor instead of emitting
        // an out-of-bounds relative cursor move at the bottom of its repaint.
        if (command.EndsWith(":prompt")) Paint(h, supportedPrompt + "\u001b[?25h");
        if (command.EndsWith(":capture")) Paint(h, prompt + "\u001b[?25h");
        if (command.EndsWith(":clear")) Paint(h, "\u001b[2J\u001b[HFixture waiting; no readiness assertion.");
        if (command.EndsWith(":uncertain")) Paint(h, "\u001b[?6h" + prompt);
        if (command.EndsWith(":record")) RecordInput(h, root);
        if (command.EndsWith(":exit")) return;
        Console.Out.Flush();
      }
      Thread.Sleep(25);
    }
  }
}
