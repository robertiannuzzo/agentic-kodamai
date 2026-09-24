module Main

import Recruitment.Example
import System

main : IO ()
main = case containerExample of
  Left err => do
    putStrLn ("ERROR " ++ show err)
    exitFailure
  Right (Failed err) => do
    putStrLn ("ERROR " ++ show err)
    exitFailure
  Right (Declined _ ev) => putStrLn ("Declined: " ++ ev.detail)
  Right (OnHold _ held) => putStrLn ("On hold: " ++ (holdEvidence held).detail)
  Right (Finished advert receipt) => do
    putStrLn "Recruitment typed-container spine demo"
    putStrLn ("Requisition reference: " ++ show (requisitionOf advert).reference)
    putStrLn ("Advert: " ++ show (advertId advert))
    putStrLn ("Policy: " ++ policyVersion)
    putStrLn (show (breakdown receipt.score))
    putStrLn ("Total: " ++ show (totalScore receipt.score))
    putStrLn ("Audit: " ++ receipt.evidence.detail)
    putStrLn "Human review required; this score does not make a hiring decision."
    case run hireAgent (advert ** (receipt.score, MkContext "hr" 5, MkStarter "Ada Candidate" 6)) of
      Left err => do
        putStrLn ("ERROR " ++ show err)
        exitFailure
      Right (employee ** _) => do
        let (a ** app) = provenanceOf employee
        putStrLn ("Hired: " ++ (starterOf employee).legalName ++ " from advert " ++
                  show (advertId a) ++ ", application " ++ show (applicationId app))
