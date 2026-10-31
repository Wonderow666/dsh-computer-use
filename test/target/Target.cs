// Minimal Win32/WinForms target for the input-injection test: one edit box,
// one Save button that dumps the edit box to argv[0]. Native controls, so the
// UI Automation tree exposes real element ids for `invoke`.
using System;
using System.Drawing;
using System.Windows.Forms;

public class Target : Form
{
    private TextBox box;
    private string outPath;

    public Target(string path)
    {
        outPath = path;
        Text = "DSH Computer-Use Test Target";
        ClientSize = new Size(520, 160);
        StartPosition = FormStartPosition.CenterScreen;

        box = new TextBox();
        box.Location = new Point(16, 20);
        box.Size = new Size(480, 28);
        box.Name = "inputBox";
        box.AccessibleName = "inputBox";
        Controls.Add(box);

        Button save = new Button();
        save.Text = "Save";
        save.Location = new Point(16, 70);
        save.Size = new Size(120, 34);
        save.Name = "saveButton";
        save.AccessibleName = "saveButton";
        save.Click += new EventHandler(OnSave);
        Controls.Add(save);

        Button quit = new Button();
        quit.Text = "Quit";
        quit.Location = new Point(150, 70);
        quit.Size = new Size(120, 34);
        quit.Name = "quitButton";
        quit.AccessibleName = "quitButton";
        quit.Click += new EventHandler(delegate(object s, EventArgs e) { Close(); });
        Controls.Add(quit);
    }

    private void OnSave(object sender, EventArgs e)
    {
        System.IO.File.WriteAllText(outPath, box.Text, System.Text.Encoding.UTF8);
        box.Text = box.Text; // keep focus semantics
        Text = "DSH Computer-Use Test Target - saved";
    }

    [STAThread]
    public static void Main(string[] args)
    {
        string path = args.Length > 0 ? args[0] : "out.txt";
        Application.Run(new Target(path));
    }
}
