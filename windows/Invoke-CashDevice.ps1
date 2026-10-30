param(
    [Parameter(Mandatory=$true)][string]$PrinterName,
    [ValidateSet('drawer','receipt','inspect')][string]$Kind = 'inspect',
    [string]$PayloadPath,
    [string]$RequestId
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class AlGymCashDevice {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DOC_INFO_1 {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct SYSTEMTIME {
        public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOB_INFO_1 {
        public uint JobId;
        public IntPtr PrinterName, MachineName, UserName, Document, Datatype, StatusText;
        public uint Status, Priority, Position, TotalPages, PagesPrinted;
        public SYSTEMTIME Submitted;
    }
    public sealed class Result {
        public uint JobId;
        public int BytesWritten;
        public bool AcceptedBySpooler;
        public bool LeftQueue;
        public bool CancelledOwnJob;
        public uint LastJobStatus;
        public string Outcome;
    }
    [DllImport("winspool.drv", EntryPoint="OpenPrinterW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
    [DllImport("winspool.drv", SetLastError=true)]
    static extern bool ClosePrinter(IntPtr handle);
    [DllImport("winspool.drv", EntryPoint="StartDocPrinterW", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint StartDocPrinter(IntPtr handle, uint level, ref DOC_INFO_1 doc);
    [DllImport("winspool.drv", SetLastError=true)]
    static extern bool StartPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)]
    static extern bool WritePrinter(IntPtr handle, byte[] data, int count, out int written);
    [DllImport("winspool.drv", SetLastError=true)]
    static extern bool EndPagePrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)]
    static extern bool EndDocPrinter(IntPtr handle);
    [DllImport("winspool.drv", SetLastError=true)]
    static extern bool AbortPrinter(IntPtr handle);
    [DllImport("winspool.drv", EntryPoint="GetJobW", SetLastError=true)]
    static extern bool GetJob(IntPtr handle, uint id, uint level, IntPtr data, uint size, out uint needed);
    [DllImport("winspool.drv", EntryPoint="SetJobW", SetLastError=true)]
    static extern bool SetJob(IntPtr handle, uint id, uint level, IntPtr data, uint command);

    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    static JOB_INFO_1? QueryJob(IntPtr handle, uint id) {
        uint needed;
        GetJob(handle, id, 1, IntPtr.Zero, 0, out needed);
        int error = Marshal.GetLastWin32Error();
        if (needed == 0 && (error == 87 || error == 2)) return null;
        if (needed == 0) throw new Win32Exception(error, "GetJob size");
        IntPtr memory = Marshal.AllocHGlobal((int)needed);
        try {
            if (!GetJob(handle, id, 1, memory, needed, out needed)) {
                error = Marshal.GetLastWin32Error();
                if (error == 87 || error == 2) return null;
                throw new Win32Exception(error, "GetJob");
            }
            return (JOB_INFO_1)Marshal.PtrToStructure(memory, typeof(JOB_INFO_1));
        } finally { Marshal.FreeHGlobal(memory); }
    }


    [StructLayout(LayoutKind.Sequential)]
    public struct PRINTER_INFO_2 {
        public IntPtr ServerName, PrinterName, ShareName, PortName, DriverName, Comment, Location;
        public IntPtr DevMode, SepFile, PrintProcessor, Datatype, Parameters, SecurityDescriptor;
        public uint Attributes, Priority, DefaultPriority, StartTime, UntilTime, Status, Jobs, AveragePPM;
    }
    public sealed class PrinterState { public uint Status, Jobs; public string Port; }
    [DllImport("winspool.drv", EntryPoint="GetPrinterW", SetLastError=true)]
    static extern bool GetPrinter(IntPtr handle, uint level, IntPtr data, uint size, out uint needed);
    static PrinterState InspectHandle(IntPtr handle) {
        uint needed;
        GetPrinter(handle, 2, IntPtr.Zero, 0, out needed);
        if (needed == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "GetPrinter size");
        IntPtr memory = Marshal.AllocHGlobal((int)needed);
        try {
            Check(GetPrinter(handle, 2, memory, needed, out needed), "GetPrinter");
            var info = (PRINTER_INFO_2)Marshal.PtrToStructure(memory, typeof(PRINTER_INFO_2));
            return new PrinterState { Status = info.Status, Jobs = info.Jobs, Port = Marshal.PtrToStringUni(info.PortName) };
        } finally { Marshal.FreeHGlobal(memory); }
    }
    public static PrinterState Inspect(string name) {
        IntPtr handle;
        Check(OpenPrinter(name, out handle, IntPtr.Zero), "OpenPrinter");
        try { return InspectHandle(handle); } finally { ClosePrinter(handle); }
    }

    public static Result SendOnce(string name, byte[] pulse, string requestId) {
        var result = new Result();
        IntPtr handle;
        Check(OpenPrinter(name, out handle, IntPtr.Zero), "OpenPrinter");
        bool documentOpen = false;
        try {
            var state = InspectHandle(handle);
            if (state.Status != 0 || state.Jobs != 0)
                throw new InvalidOperationException("La impresora no esta lista o tiene trabajos pendientes.");
            var doc = new DOC_INFO_1 {
                pDocName = "AlGym-" + requestId,
                pOutputFile = null,
                pDatatype = "RAW"
            };
            result.JobId = StartDocPrinter(handle, 1, ref doc);
            if (result.JobId == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter");
            documentOpen = true;
            Check(StartPagePrinter(handle), "StartPagePrinter");
            int written;
            Check(WritePrinter(handle, pulse, pulse.Length, out written), "WritePrinter");
            result.BytesWritten = written;
            if (written != pulse.Length) throw new InvalidOperationException("Envio incompleto; no se reintentara.");
            Check(EndPagePrinter(handle), "EndPagePrinter");
            Check(EndDocPrinter(handle), "EndDocPrinter");
            documentOpen = false;
            result.AcceptedBySpooler = true;
            var timer = Stopwatch.StartNew();
            while (timer.ElapsedMilliseconds < 8000) {
                var job = QueryJob(handle, result.JobId);
                if (!job.HasValue) {
                    result.LeftQueue = true;
                    result.Outcome = "Orden enviada y retirada de la cola. Apertura fisica pendiente de confirmacion.";
                    return result;
                }
                result.LastJobStatus = job.Value.Status;
                // Error, offline, falta de papel, cola bloqueada o intervencion del usuario.
                if ((job.Value.Status & (0x2u | 0x20u | 0x40u | 0x200u | 0x400u)) != 0) break;
                Thread.Sleep(200);
            }
            // Solo elimina el trabajo de ESTA prueba para evitar una apertura tardia.
            result.CancelledOwnJob = SetJob(handle, result.JobId, 0, IntPtr.Zero, 5);
            if (!result.CancelledOwnJob) {
                var finalJob = QueryJob(handle, result.JobId);
                if (!finalJob.HasValue) result.LeftQueue = true;
                else throw new Win32Exception(Marshal.GetLastWin32Error(), "No se pudo cancelar el trabajo propio");
            }
            result.Outcome = result.CancelledOwnJob
                ? "Trabajo propio cancelado por demora o error. No se reintentara automaticamente."
                : "El trabajo salio de la cola; apertura fisica pendiente de confirmacion.";
            return result;
        } catch {
            if (documentOpen) AbortPrinter(handle);
            if (result.JobId != 0) SetJob(handle, result.JobId, 0, IntPtr.Zero, 5);
            throw;
        } finally { ClosePrinter(handle); }
    }
}
'@
if ($Kind -eq 'inspect') {
    [AlGymCashDevice]::Inspect($PrinterName) | ConvertTo-Json -Compress
    exit 0
}
$parsedRequest = [Guid]::Empty
if (-not [Guid]::TryParse($RequestId, [ref]$parsedRequest)) { throw 'Solicitud invalida' }
[byte[]]$bytes = [IO.File]::ReadAllBytes($PayloadPath)
if ($Kind -eq 'drawer') {
    if ([BitConverter]::ToString($bytes) -ne '1B-70-00-32-FA') { throw 'Orden de apertura invalida' }
} else {
    if ($bytes.Length -lt 3 -or $bytes.Length -gt 32768 -or $bytes[0] -ne 27 -or $bytes[1] -ne 64) {
        throw 'Recibo invalido'
    }
    # Tras ESC @ solo se acepta texto ASCII y saltos de linea. Nunca ESC p.
    for ($index=2; $index -lt $bytes.Length; $index++) {
        if ($bytes[$index] -ne 10 -and ($bytes[$index] -lt 32 -or $bytes[$index] -gt 126)) { throw 'Caracter de control no permitido' }
    }
}
$guardPath = Join-Path (Split-Path -Parent $PayloadPath) ($parsedRequest.ToString() + '.sent')
$guard = [IO.File]::Open($guardPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$guard.Dispose()
$state = [AlGymCashDevice]::Inspect($PrinterName)
if ($state.Status -ne 0 -or $state.Jobs -ne 0) {
    @{status='failed';message='La impresora esta ocupada o no esta lista. El cobro permanece registrado.'} | ConvertTo-Json -Compress
    exit 0
}
try {
    $result = [AlGymCashDevice]::SendOnce($PrinterName, $bytes, $parsedRequest.ToString())
    $status = if ($result.LeftQueue) {'sent'} elseif ($result.CancelledOwnJob) {'failed'} else {'unknown'}
    $message = if ($status -eq 'sent') {'Orden enviada al equipo.'} else {'No se confirmo el envio. Se cancelo el trabajo pendiente; comprueba el equipo.'}
    @{status=$status;message=$message;jobId=$result.JobId} | ConvertTo-Json -Compress
} catch {
    @{status='unknown';message='No se pudo confirmar la orden. Comprueba el equipo antes de reintentar.'} | ConvertTo-Json -Compress
}
