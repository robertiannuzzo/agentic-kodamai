module MissingAudit
import Recruitment.Core.Requisition
%default total

bad : Pending r -> Evidence Submitted
bad pending = ()
