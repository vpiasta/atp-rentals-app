Attribute VB_Name = "modTPSOutlook"
Option Explicit
'
' TPS: sends the e-mails copied with "Copiar para Outlook" in the
' Trusted Panama Stays admin panel, one individual e-mail per recipient,
' from the info@trustedpanamastays.com account. Nothing goes through Brevo.
' Created 2026-11-12.
'
Private Const CUENTA_TPS As String = "info@trustedpanamastays.com"
Private Const MARCA As String = "###TPS-OUTLOOK-V1###"

Public Sub TPS_EnviarDesdePortapapeles()
    Dim txt As String, bloques() As String
    Dim i As Long, n As Long, resp As VbMsgBoxResult
    Dim cuenta As Outlook.Account, nombreCuenta As String

    txt = LeerPortapapeles()
    txt = Replace(txt, vbCrLf, vbLf)
    If InStr(1, txt, MARCA) <> 1 Then
        MsgBox "El portapapeles no contiene correos de TPS." & vbCrLf & _
               "Use primero el botón 'Copiar para Outlook' en el panel de admin.", vbExclamation, "TPS"
        Exit Sub
    End If

    bloques = Split(txt, "###MAIL###")
    n = UBound(bloques)
    If n < 1 Then
        MsgBox "No se encontró ningún correo en el portapapeles.", vbExclamation, "TPS"
        Exit Sub
    End If

    Set cuenta = BuscarCuenta(CUENTA_TPS)
    If cuenta Is Nothing Then
        nombreCuenta = "la cuenta predeterminada (no se encontró " & CUENTA_TPS & ")"
    Else
        nombreCuenta = CUENTA_TPS
    End If

    resp = MsgBox("Se crearán " & n & " correo(s) individual(es) desde " & nombreCuenta & "." & vbCrLf & vbCrLf & _
                  "Sí = enviar ahora" & vbCrLf & _
                  "No = guardar en Borradores para revisarlos" & vbCrLf & _
                  "Cancelar = no hacer nada", vbYesNoCancel + vbQuestion, "TPS")
    If resp = vbCancel Then Exit Sub

    Dim para As String, asunto As String, html As String, ok As Long, errores As String
    For i = 1 To n
        If ExtraerCorreo(bloques(i), para, asunto, html) Then
            On Error Resume Next
            Dim m As Outlook.MailItem
            Set m = Application.CreateItem(olMailItem)
            If Not cuenta Is Nothing Then Set m.SendUsingAccount = cuenta
            m.To = para
            m.Subject = asunto
            m.BodyFormat = olFormatHTML
            m.HTMLBody = html
            If resp = vbYes Then m.Send Else m.Save
            If Err.Number = 0 Then
                ok = ok + 1
            Else
                errores = errores & para & ": " & Err.Description & vbCrLf
                Err.Clear
            End If
            On Error GoTo 0
            Set m = Nothing
        Else
            errores = errores & "Bloque " & i & ": formato no reconocido" & vbCrLf
        End If
    Next i

    MsgBox ok & " de " & n & " correo(s) " & IIf(resp = vbYes, "enviado(s).", "guardado(s) en Borradores.") & _
           IIf(Len(errores) > 0, vbCrLf & vbCrLf & "Errores:" & vbCrLf & errores, ""), _
           IIf(Len(errores) > 0, vbExclamation, vbInformation), "TPS"
End Sub

' Splits one block into recipient, subject and HTML.
Private Function ExtraerCorreo(ByVal b As String, ByRef para As String, ByRef asunto As String, ByRef html As String) As Boolean
    Dim p As Long, q As Long
    ExtraerCorreo = False
    p = InStr(1, b, "TO: ")
    If p = 0 Then Exit Function
    q = InStr(p, b, vbLf)
    para = Trim$(Mid$(b, p + 4, q - p - 4))

    p = InStr(1, b, "SUBJECT: ")
    If p = 0 Then Exit Function
    q = InStr(p, b, vbLf)
    asunto = Trim$(Mid$(b, p + 9, q - p - 9))

    p = InStr(1, b, "###HTML###" & vbLf)
    If p = 0 Then Exit Function
    html = Mid$(b, p + Len("###HTML###") + 1)
    q = InStr(1, html, "###END###")
    If q > 0 Then html = Left$(html, q - 1)

    ExtraerCorreo = (InStr(para, "@") > 0 And Len(html) > 0)
End Function

Private Function BuscarCuenta(ByVal direccion As String) As Outlook.Account
    Dim a As Outlook.Account
    For Each a In Application.Session.Accounts
        If LCase$(a.SmtpAddress) = LCase$(direccion) Then
            Set BuscarCuenta = a
            Exit Function
        End If
    Next a
    Set BuscarCuenta = Nothing
End Function

' Reads Unicode text from the clipboard (Microsoft Forms DataObject, late-bound,
' so no reference to "Microsoft Forms 2.0" is needed).
Private Function LeerPortapapeles() As String
    On Error GoTo Fallo
    Dim d As Object
    Set d = CreateObject("new:{1C3B4210-F441-11CE-B9EA-00AA006B1A69}")
    d.GetFromClipboard
    LeerPortapapeles = d.GetText(1)
    Exit Function
Fallo:
    LeerPortapapeles = ""
End Function
