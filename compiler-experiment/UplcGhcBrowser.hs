{-# LANGUAGE ForeignFunctionInterface #-}
{-# LANGUAGE ImportQualifiedPost #-}

module UplcGhcBrowser (uplcGhcBrowser) where

import Control.Exception qualified as Exception
import Control.Monad (forM, forM_, unless, when)
import Control.Monad.IO.Class (liftIO)
import Data.Coerce (coerce)
import Data.Char (isAlphaNum)
import Data.List (isPrefixOf, isSuffixOf, sort)
import Data.IORef (IORef, newIORef, readIORef, writeIORef)
import Data.Version (Version (Version))
import Data.Word (Word8)
import Data.ByteString qualified as ByteString
import Data.ByteString.Char8 qualified as ByteString.Char8
import GHC
import GHC.Data.ShortText qualified as ShortText
import GHC.Driver.Backend (interpreterBackend)
import GHC.Driver.Config.Diagnostic (initDiagOpts, initPrintConfig)
import GHC.Driver.Env (hsc_plugins)
import GHC.Driver.Errors (printOrThrowDiagnostics)
import GHC.Driver.Errors.Types (GhcMessage (GhcDriverMessage))
import GHC.Driver.Monad (Session (Session), modifySession, reflectGhc)
import GHC.Driver.Plugins
  ( PluginWithArgs (PluginWithArgs)
  , Plugins (staticPlugins)
  , StaticPlugin (StaticPlugin)
  )
import GHC.Driver.Session
  ( GeneralFlag (Opt_PluginTrustworthy, Opt_WriteIfSimplifiedCore)
  , backend
  , defaultFatalMessager
  , defaultFlushOut
  , ghcLink
  , ghcMode
  , gopt_set
  , hiSuf_
  , pluginModNameOpts
  , verbosity
  )
import GHC.Runtime.Loader (initializeSessionPlugins)
import GHC.Unit.Database
  ( DbUnitInfo
  , GenericUnitInfo (..)
  , writePackageDb
  )
import GHC.Utils.Exception (evaluate)
import GHC.Wasm.Prim
  ( JSString (JSString)
  , JSVal
  , freeJSVal
  , fromJSString
  , toJSString
  )
import Numeric (showHex)
import Plinth.Plugin qualified
import Prelude
import System.Directory
  ( createDirectoryIfMissing
  , doesFileExist
  , listDirectory
  , removeFile
  )
import System.Environment (setEnv)
import System.FilePath ((</>), replaceExtension, takeDirectory)

newtype JSFunction a = JSFunction JSVal

type CompileFunction = JSString -> JSString -> IO JSString

-- | Create one reusable, fully client-side uplc-ghc session. The returned
-- JavaScript async function accepts GHC flags and a NUL-delimited project.
uplcGhcBrowser :: JSString -> JSString -> IO (JSFunction CompileFunction)
uplcGhcBrowser jsLibdir jsPackagePath =
  defaultErrorHandler defaultFatalMessager defaultFlushOut $ do
    libdir <- evaluate $ fromJSString jsLibdir
    packagePath <- evaluate $ fromJSString jsPackagePath
    freeJSVal $ coerce jsLibdir
    freeJSVal $ coerce jsPackagePath
    setEnv "GHC_PACKAGE_PATH" packagePath
    projectFiles <- newIORef []
    toCompileFunction $ \jsArgs jsProject ->
      defaultErrorHandler defaultFatalMessager defaultFlushOut $ do
        args <- evaluate $ words $ fromJSString jsArgs
        project <- evaluate $ fromJSString jsProject
        freeJSVal $ coerce jsArgs
        freeJSVal $ coerce jsProject
        modules <- evaluate $ parseProject project
        removePreviousOutputs
        writeProject projectFiles modules
        let supportModules = filter ((/= "Main.hs") . fst) modules
            supportPaths = map ((projectRoot </>) . fst) supportModules
            hasSupportModules = not $ null supportPaths
        when hasSupportModules $ do
          compileSupportModules libdir args supportPaths
          writeUserPackageDb $ map (moduleNameFromPath . fst) supportModules
          mapM_ removeFile supportPaths
        setEnv
          "GHC_PACKAGE_PATH"
          (if hasSupportModules then userPackageDb <> ":" <> packagePath else packagePath)
        compileMainModule libdir args hasSupportModules
        setEnv "GHC_PACKAGE_PATH" packagePath
        toJSString <$> collectOutputs
compileSupportModules :: FilePath -> [String] -> [FilePath] -> IO ()
compileSupportModules libdir args supportPaths = do
  supportSession <- Session <$> newIORef undefined
  flip reflectGhc supportSession $ withCleanupSession $ do
    initGhcMonad $ Just libdir
    initial <- getSessionDynFlags
    logger <- getLogger
    (parsedFlags, leftovers, warnings) <-
      parseDynamicFlags
        logger
        initial
        ( map noLoc args
            <> [ noLoc "-dynamic"
               , noLoc "-O1"
               , noLoc "-fno-unoptimized-core-for-interpreter"
               , noLoc $ "-this-unit-id=" <> userPackageId
               ]
        )
    when (not $ null leftovers) $
      fail $ "unparsed support module arguments: " <> show (map unLoc leftovers)
    let flags =
          parsedFlags
            { ghcMode = CompManager
            , backend = interpreterBackend
            , ghcLink = LinkInMemory
            , hiSuf_ = "dyn_hi"
            , verbosity = 1
            }
            `gopt_set` Opt_WriteIfSimplifiedCore
    setSessionDynFlags flags
    logger' <- getLogger
    liftIO
      $ printOrThrowDiagnostics
        logger'
        (initPrintConfig flags)
        (initDiagOpts flags)
      $ GhcDriverMessage <$> warnings
    setTargets =<< mapM (\path -> guessTarget path Nothing Nothing) supportPaths
    result <- load LoadAllTargets
    when (failed result) $ fail "uplc-ghc support module load returned Failed"

compileMainModule :: FilePath -> [String] -> Bool -> IO ()
compileMainModule libdir args hasSupportModules = do
  session <- Session <$> newIORef undefined
  flip reflectGhc session $ withCleanupSession $ do
    initGhcMonad $ Just libdir
    initial <- getSessionDynFlags
    logger <- getLogger
    let packageArgs =
          [flag | hasSupportModules, flag <- ["-dynamic", "-package=" <> userPackageId]]
    (parsedFlags, leftovers, warnings) <-
      parseDynamicFlags logger initial $ map noLoc $ args <> packageArgs
    when (not $ null leftovers) $
      fail $ "unparsed GHC arguments: " <> show (map unLoc leftovers)
    let flags =
          parsedFlags
            { ghcMode = CompManager
            , ghcLink = NoLink
            , verbosity = 1
            }
            `gopt_set` Opt_WriteIfSimplifiedCore
            `gopt_set` Opt_PluginTrustworthy
    setSessionDynFlags flags
    logger' <- getLogger
    liftIO
      $ printOrThrowDiagnostics
        logger'
        (initPrintConfig flags)
        (initDiagOpts flags)
      $ GhcDriverMessage <$> warnings
    installPlinthPlugin flags
    initializeSessionPlugins
    setTargets =<< (: []) <$> guessTarget (projectRoot </> "Main.hs") Nothing Nothing
    result <- load LoadAllTargets
    when (failed result) $ fail "uplc-ghc load returned Failed"

projectRoot :: FilePath
projectRoot = "/tmp/plinth-project"

userPackageId :: String
userPackageId = "plinth-user-modules"

userPackageDb :: FilePath
userPackageDb = projectRoot </> "package.conf.d"

writeUserPackageDb :: [String] -> IO ()
writeUserPackageDb moduleNames = do
  createDirectoryIfMissing True userPackageDb
  let cachePath = userPackageDb </> "package.cache"
  result <-
    Exception.try (writePackageDb cachePath [userPackageInfo moduleNames] ())
      :: IO (Either Exception.IOException ())
  case result of
    Right () -> pure ()
    Left packageDbError -> do
      cacheExists <- doesFileExist cachePath
      unless cacheExists $ Exception.throwIO packageDbError

userPackageInfo :: [String] -> DbUnitInfo
userPackageInfo moduleNames =
  GenericUnitInfo
    { unitId = bytes userPackageId
    , unitInstanceOf = bytes userPackageId
    , unitInstantiations = []
    , unitPackageId = bytes userPackageId
    , unitPackageName = bytes userPackageId
    , unitPackageVersion = Version [0] []
    , unitComponentName = Nothing
    , unitAbiHash = shortText ""
    , unitDepends = []
    , unitAbiDepends = []
    , unitImportDirs = [shortText projectRoot]
    , unitLibraries = []
    , unitExtDepLibsSys = []
    , unitExtDepLibsGhc = []
    , unitLibraryDirs = []
    , unitLibraryDynDirs = []
    , unitExtDepFrameworks = []
    , unitExtDepFrameworkDirs = []
    , unitLinkerOptions = []
    , unitCcOptions = []
    , unitIncludes = []
    , unitIncludeDirs = []
    , unitHaddockInterfaces = []
    , unitHaddockHTMLs = []
    , unitExposedModules = [(bytes moduleName, Nothing) | moduleName <- moduleNames]
    , unitHiddenModules = []
    , unitIsIndefinite = False
    , unitIsExposed = True
    , unitIsTrusted = True
    }
  where
    bytes = ByteString.Char8.pack
    shortText = ShortText.pack

moduleNameFromPath :: FilePath -> String
moduleNameFromPath path = map slashToDot $ take (length path - length ".hs") path
  where
    slashToDot '/' = '.'
    slashToDot character = character

projectMarker :: String
projectMarker = "PLINTH_PROJECT_V1"

parseProject :: String -> [(FilePath, String)]
parseProject value =
  case splitNul value of
    marker : fields
      | marker == projectMarker ->
          case pairs fields of
            Just modules
              | not (null modules)
              , any ((== "Main.hs") . fst) modules
              , all (isSafeProjectPath . fst) modules
              , unique (map fst modules) -> modules
            _ -> error "invalid Plinth project bundle"
    _ -> [("Main.hs", value)]

splitNul :: String -> [String]
splitNul [] = [""]
splitNul value =
  let (field, rest) = break (== '\NUL') value
   in field : case rest of
        [] -> []
        _ : remaining -> splitNul remaining

pairs :: [a] -> Maybe [(a, a)]
pairs [] = Just []
pairs (left : right : rest) = ((left, right) :) <$> pairs rest
pairs _ = Nothing

unique :: Eq a => [a] -> Bool
unique [] = True
unique (item : rest) = item `notElem` rest && unique rest

isSafeProjectPath :: FilePath -> Bool
isSafeProjectPath path =
  not (null path)
    && not ("/" `isPrefixOf` path)
    && ".hs" `isSuffixOf` path
    && all validPathCharacter path
    && all validComponent (splitSlash path)
  where
    validPathCharacter character =
      isAlphaNum character || character `elem` ("_-./" :: String)
    validComponent component =
      not (null component) && component /= "." && component /= ".."

splitSlash :: String -> [String]
splitSlash [] = [""]
splitSlash value =
  let (component, rest) = break (== '/') value
   in component : case rest of
        [] -> []
        _ : remaining -> splitSlash remaining

writeProject :: IORef [FilePath] -> [(FilePath, String)] -> IO ()
writeProject projectFiles modules = do
  previousFiles <- readIORef projectFiles
  forM_ previousFiles $ \path -> do
    exists <- doesFileExist path
    when exists $ removeFile path
  createDirectoryIfMissing True projectRoot
  forM_ modules $ \(path, source) -> do
    let destination = projectRoot </> path
    createDirectoryIfMissing True $ takeDirectory destination
    writeFile destination source
  writeIORef projectFiles $ concatMap (projectArtifacts . (projectRoot </>) . fst) modules

projectArtifacts :: FilePath -> [FilePath]
projectArtifacts path =
  [ path
  , replaceExtension path "hi"
  , replaceExtension path "dyn_hi"
  , replaceExtension path "o"
  , replaceExtension path "dyn_o"
  ]

removePreviousOutputs :: IO ()
removePreviousOutputs = do
  outputs <- filter isBrowserOutput <$> listDirectory "."
  mapM_ removeFile outputs

collectOutputs :: IO String
collectOutputs = do
  outputs <- sort . filter isBrowserOutput <$> listDirectory "."
  when (null outputs) $ fail "Plinth produced no Flat UPLC output"
  encoded <- forM outputs $ \output -> do
    bytes <- ByteString.readFile output
    pure $ output <> "\t" <> concatMap hexByte (ByteString.unpack bytes)
  pure $ unlines encoded

isBrowserOutput :: FilePath -> Bool
isBrowserOutput = isSuffixOf ".uplc-flat"

hexByte :: Word8 -> String
hexByte byte =
  case showHex byte "" of
    [digit] -> ['0', digit]
    digits -> digits

installPlinthPlugin :: DynFlags -> Ghc ()
installPlinthPlugin flags = do
  let pluginName = mkModuleName "Plinth.Plugin"
      pluginArgs =
        [ option
        | (name, option) <- pluginModNameOpts flags
        , name == pluginName
        ]
      plugin =
        StaticPlugin
          (PluginWithArgs Plinth.Plugin.plugin pluginArgs)
          False
  modifySession $ \environment ->
    let plugins = hsc_plugins environment
     in environment
          { hsc_plugins = plugins {staticPlugins = [plugin]}
          }

foreign import javascript "wrapper"
  toCompileFunction ::
    CompileFunction ->
    IO (JSFunction CompileFunction)

foreign export javascript "uplcGhcBrowser"
  uplcGhcBrowser ::
    JSString ->
    JSString ->
    IO (JSFunction CompileFunction)
