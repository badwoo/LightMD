; LightMD NSIS 安装器钩子（v0.5.0 F2 修复）
;
; 修复问题：v0.4.5 及之前版本将 sh/bash/zsh/bat/cmd/ps1 注册为 LightMD 默认
; 打开方式（fileAssociations 中的 "Script" 组），导致系统脚本文件被劫持。
;
; v0.5.0 起整组移除该关联（用户可自行右键"打开方式"设置默认）。
; 本钩子在安装完成后清理旧版本写入 HKCU\Software\Classes 的残留：
;   1. .ext 键：若默认值仍指向 ProgID "Script"，恢复 Script_backup 备份
;      的原默认值（备份为空则删除默认值，回到系统默认）
;   2. Script_backup 备份值本身
;   3. ProgID 键 Software\Classes\Script（DefaultIcon / shell\open\command）
!include LogicLib.nsh

!macro CLEANUP_SCRIPT_ASSOC EXT
  ; 仅当 .ext 默认值仍是 LightMD 注册的 "Script" ProgID 时才清理，
  ; 避免误删用户后来手动设置的其他默认打开方式
  ; （使用 $R0/$R1 寄存器，避免与安装器主流程的 $0/$1 冲突）
  ReadRegStr $R0 HKCU "Software\Classes\.${EXT}" ""
  ${If} $R0 == "Script"
    ReadRegStr $R1 HKCU "Software\Classes\.${EXT}" "Script_backup"
    ${If} $R1 == ""
      ; 原本无默认值：删除默认值，回到系统默认关联
      DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
    ${Else}
      ; 恢复安装前的原默认值
      WriteRegStr HKCU "Software\Classes\.${EXT}" "" "$R1"
    ${EndIf}
    DeleteRegValue HKCU "Software\Classes\.${EXT}" "Script_backup"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 清理 v0.4.5 及之前版本错误注册的 Script 文件关联残留
  !insertmacro CLEANUP_SCRIPT_ASSOC "sh"
  !insertmacro CLEANUP_SCRIPT_ASSOC "bash"
  !insertmacro CLEANUP_SCRIPT_ASSOC "zsh"
  !insertmacro CLEANUP_SCRIPT_ASSOC "bat"
  !insertmacro CLEANUP_SCRIPT_ASSOC "cmd"
  !insertmacro CLEANUP_SCRIPT_ASSOC "ps1"
  ; 删除 ProgID 定义键（所有扩展默认值已不指向它）
  DeleteRegKey HKCU "Software\Classes\Script"
  ; 通知资源管理器刷新关联（忽略失败）
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
